#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/check-deps.sh"

usage() {
  cat <<EOF
Usage: $0 <command> [options]

Commands:
  deploy      Build and deploy Capability Insights into your AWS account
  teardown    Remove the deployed stack and website assets

Deploy options (pass as flags or omit to be prompted):
  --private-vpc-id <id>                  Private VPC ID
  --backend-subnet-id <id>               Subnet ID for Lambda backend
  --api-access-subnet-id <id>            Subnet ID for API Gateway VPC endpoint
  --deployment-assets-bucket-name <name> S3 bucket for deployment assets
  --source-access-point-arn <arn>        S3 access point ARN for capability data source
  --source-folders <folders>             Comma-separated list of source folders (default: public)
  --enable-usage-analysis                Deploy the Usage Analysis stack
  --cloudtrail-bucket <name>             S3 bucket containing CloudTrail logs (for usage analysis,
                                         auto-discovered from your account's CloudTrail trails if omitted)
  --enable-policy-enforcer               Deploy the Policy Enforcer stack (regional governance
                                         policies generated from the catalog)
  --enable-chat                          Deploy the Chat assistant stack (Bedrock-backed
                                         conversational agent). Requires Bedrock + Claude in
                                         the deploy region; unavailable in GovCloud/sovereign/ADC.
  --bedrock-model-id <id>                Bedrock model or cross-region inference profile id for
                                         chat (default: us.anthropic.claude-haiku-4-5-20251001-v1:0)
  --deployer-role-name <name>            IAM role name this deployment runs as. Registered as a
                                         Lake Formation Data Lake Admin by the Usage Analysis stack
                                         so its LF grants succeed. If omitted, it is derived from
                                         your current caller identity (falling back to "Admin").
                                         Only relevant with --enable-usage-analysis.
  -y, --yes                              Skip confirmation prompts

Examples:
  # Provide all parameters inline
  $0 deploy \\
    --private-vpc-id vpc-0abc123 \\
    --backend-subnet-id subnet-0abc123 \\
    --api-access-subnet-id subnet-0def456 \\
    --deployment-assets-bucket-name my-deploy-bucket \\
    --source-access-point-arn arn:aws:s3:us-east-1:123456789012:accesspoint/my-access-point \\
    --source-folders public

  # Interactive — prompts for any missing parameters
  $0 deploy

  $0 teardown

EOF
  exit 1
}

get_account_and_region() {
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  REGION=$(aws configure get region || echo "us-east-1")
}

prompt_if_empty() {
  local varname=$1
  local prompt=$2
  local current="${!varname}"
  if [[ -z "$current" ]]; then
    read -rp "$prompt: " current
    printf -v "$varname" '%s' "$current"
  fi
}

# Preflight for --enable-chat: the Chat stack grants the IAM permission to call
# Bedrock, but it CANNOT enable account-level model access — that's a per-account,
# per-region Bedrock setting (and a use-case agreement for Anthropic models) the
# account owner must enable in the Bedrock console. Without it the stack deploys
# fine but every chat call fails at runtime with AccessDeniedException. This probe
# makes that failure visible at deploy time instead. It is read-only and
# NON-FATAL: a warning, never a blocker (access may be pending, or enabled later).
check_bedrock_access() {
  local model_id=$1 region=$2
  # A 1-token Converse is the most reliable signal that the account can actually
  # invoke the model (entitlement + region), short of a full chat turn.
  if aws bedrock-runtime converse \
        --region "$region" \
        --model-id "$model_id" \
        --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
        --inference-config '{"maxTokens":1}' \
        --query 'stopReason' --output text >/dev/null 2>&1; then
    echo "  ✓ Bedrock model access confirmed: $model_id ($region)."
    return 0
  fi
  echo ""
  echo "  ⚠️  WARNING: could not invoke Bedrock model '$model_id' in $region."
  echo "      The Chat stack will still deploy, but chat requests will FAIL at"
  echo "      runtime until you enable model access for this account/region:"
  echo "        Bedrock console → Model access → enable the Anthropic Claude model"
  echo "        (accept the use-case agreement if prompted), then retry chat."
  echo "      This is an account-level setting the deploy cannot enable for you."
  echo ""
}

# Run `aws cloudformation deploy` and react to the real outcome.
#
# `aws cloudformation deploy` exits non-zero when there is nothing to deploy
# ("No changes to deploy"), which is benign, but it also exits non-zero on a
# genuine failure. The previous `|| true` swallowed both cases and let the
# script print a misleading success message. This helper distinguishes them:
# a "no changes" exit is treated as success, anything else prints the failing
# stack events and aborts the deploy.
#
# Usage: deploy_stack_checked <stack-name> <aws cloudformation deploy args...>
deploy_stack_checked() {
  local stack_name=$1
  shift

  local log_file deploy_exit
  log_file=$(mktemp)
  # Ensure the temp file is removed even if the script is interrupted
  # (Ctrl+C, kill) while the deploy is streaming.
  trap 'rm -f "$log_file"' RETURN INT TERM
  # Stream progress live (tee) while capturing output for inspection. Use
  # PIPESTATUS to read aws's exit code rather than tee's.
  aws cloudformation deploy --stack-name "$stack_name" "$@" 2>&1 | tee "$log_file"
  deploy_exit=${PIPESTATUS[0]}

  if [[ $deploy_exit -eq 0 ]]; then
    return 0
  fi

  # "No changes" variants are benign. `aws cloudformation deploy` surfaces
  # this a few different ways depending on whether it went through a direct
  # deploy or changeset creation.
  if grep -qiE "No changes to deploy|No updates are to be performed|didn't contain changes|The submitted information didn't contain changes" "$log_file"; then
    return 0
  fi

  echo "✗ Stack '$stack_name' failed to deploy."
  echo "Recent failed events:"
  aws cloudformation describe-stack-events \
    --stack-name "$stack_name" \
    --query "StackEvents[?ResourceStatus=='CREATE_FAILED'||ResourceStatus=='UPDATE_FAILED'||ResourceStatus=='ROLLBACK_IN_PROGRESS'].[LogicalResourceId,ResourceStatusReason]" \
    --output table 2>/dev/null | head -40
  echo ""
  echo "If the stack is in ROLLBACK_COMPLETE it must be deleted before retrying:"
  echo "  aws cloudformation delete-stack --stack-name $stack_name"
  rm -f "$log_file"
  exit 1
}

cmd_deploy() {
  local private_vpc_id="" backend_subnet_id="" api_access_subnet_id="" deployment_assets_bucket_name="" source_access_point_arn="" source_folders="" cloudtrail_bucket="" enable_usage_analysis="" enable_policy_enforcer="" enable_chat="" bedrock_model_id="" deployer_role_name="" auto_approve=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --private-vpc-id)                  private_vpc_id="$2"; shift 2 ;;
      --backend-subnet-id)               backend_subnet_id="$2"; shift 2 ;;
      --api-access-subnet-id)            api_access_subnet_id="$2"; shift 2 ;;
      --deployment-assets-bucket-name)   deployment_assets_bucket_name="$2"; shift 2 ;;
      --source-access-point-arn)         source_access_point_arn="$2"; shift 2 ;;
      --source-folders)                  source_folders="$2"; shift 2 ;;
      --cloudtrail-bucket)               cloudtrail_bucket="$2"; shift 2 ;;
      --enable-usage-analysis)           enable_usage_analysis="true"; shift ;;
      --enable-policy-enforcer)          enable_policy_enforcer="true"; shift ;;
      --enable-chat)                     enable_chat="true"; shift ;;
      --bedrock-model-id)                bedrock_model_id="$2"; shift 2 ;;
      --deployer-role-name)              deployer_role_name="$2"; shift 2 ;;
      -y|--yes)                          auto_approve="true"; shift ;;
      *) echo "Unknown option: $1"; usage ;;
    esac
  done

  echo "── Capability Insights — Deploy ──"
  echo ""

  prompt_if_empty private_vpc_id "PrivateVpcId"
  prompt_if_empty backend_subnet_id "BackendSubnetId"
  prompt_if_empty api_access_subnet_id "ApiAccessSubnetId"
  prompt_if_empty deployment_assets_bucket_name "DeploymentAssetsBucketName"
  prompt_if_empty source_access_point_arn "SourceAccessPointArn"
  prompt_if_empty source_folders "SourceFolders (comma-separated, default: public)"
  if [[ -z "$source_folders" ]]; then
    source_folders="public"
  fi
  while [[ ! "$source_folders" =~ ^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$ ]]; do
    echo "Invalid format. Must be a comma-separated list of folder names (letters, numbers, hyphens, underscores)."
    read -rp "SourceFolders (comma-separated, default: public): " source_folders
    if [[ -z "$source_folders" ]]; then
      source_folders="public"
    fi
  done

  # Auto-discover a CloudTrail bucket when --enable-usage-analysis is set
  # but --cloudtrail-bucket was not. Queries CloudTrail directly for the
  # account's configured trails and pulls the S3 bucket from the matching
  # one. If multiple match, list and prompt; if none, prompt with a hint.
  if [[ "$enable_usage_analysis" == "true" && -z "$cloudtrail_bucket" ]]; then
    local discovered_buckets
    discovered_buckets=$(aws cloudtrail describe-trails --query 'trailList[].S3BucketName' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' | sort -u || true)
    local discovered_count
    discovered_count=$(printf '%s\n' "$discovered_buckets" | grep -c . || true)
    if [[ "$discovered_count" == "1" ]]; then
      cloudtrail_bucket="$discovered_buckets"
      echo "Auto-discovered CloudTrail bucket: $cloudtrail_bucket"
    elif [[ "$discovered_count" -gt 1 ]]; then
      echo "Multiple CloudTrail buckets found:"
      printf '  %s\n' $discovered_buckets
      prompt_if_empty cloudtrail_bucket "CloudTrailBucket (paste one of the above)"
    else
      echo "No CloudTrail trails found in this account/region. Configure CloudTrail to log to S3, or pass --cloudtrail-bucket explicitly."
      prompt_if_empty cloudtrail_bucket "CloudTrailBucket"
    fi
  fi

  echo ""
  echo "Deploying to account $AWS_ACCOUNT in $AWS_REGION"
  if [[ "$auto_approve" != "true" ]]; then
    read -rp "Continue? (y/N): " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
  fi

  echo "── Uploading Lambda zip ──"
  local lambda_key
  lambda_key="lambdaAssets-$(date +%s).zip"
  aws s3 cp "$SCRIPT_DIR/dist/lambda/lambdaAssets.zip" "s3://$deployment_assets_bucket_name/$lambda_key"

  echo "── Deploying CloudFormation stack (this will likely take ~15 minutes for first time deployment) ──"
  aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/dist/template/capability-insights.template.json" \
    --stack-name CapabilityInsightsForAWS \
    --parameter-overrides \
      PrivateVpcId="$private_vpc_id" \
      BackendSubnetId="$backend_subnet_id" \
      ApiAccessSubnetId="$api_access_subnet_id" \
      DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
      DeploymentAssetsBucketApiLambdaFunctionCodeZipPath="$lambda_key" \
      SourceAccessPointArn="$source_access_point_arn" \
      SourceFolders="$source_folders" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-cli-pager 2>&1 | tee /tmp/cfn-deploy.log &
  local deploy_pid=$!
  local elapsed=0
  local status="STARTING"
  while kill -0 "$deploy_pid" 2>/dev/null; do
    if (( elapsed % 15 == 0 )); then
      status=$(aws cloudformation describe-stacks --stack-name CapabilityInsightsForAWS \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null) || status="CREATING"
    fi
    printf "\r  ⏳ %s (%dm %ds elapsed)" "$status" $((elapsed/60)) $((elapsed%60))
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$deploy_pid"
  local deploy_exit=$?
  printf "\r%60s\r" ""
  if [[ $deploy_exit -ne 0 ]]; then
    echo "✗ Stack deployment failed."
    if aws cloudformation describe-stacks --stack-name CapabilityInsightsForAWS --query "Stacks[0].StackStatus" --output text 2>/dev/null; then
      echo "Recent failed events:"
      aws cloudformation describe-stack-events \
        --stack-name CapabilityInsightsForAWS \
        --query "StackEvents[?ResourceStatus=='CREATE_FAILED'||ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
        --output table 2>/dev/null
    else
      echo "Stack was deleted after rollback. Check /tmp/cfn-deploy.log for details."
    fi
    exit 1
  fi
  echo "  ✓ Stack deployed."

  echo "── Uploading website assets ──"
  get_account_and_region
  local website_bucket="capability-insights-website-${ACCOUNT_ID}-${REGION}"
  local website_bucket_arn="arn:aws:s3:::${website_bucket}"
  aws s3 sync "$SCRIPT_DIR/dist/website/" "s3://$website_bucket/"

  echo "── Deploying Usage Analysis stack ──"
  if [[ "$enable_usage_analysis" == "true" ]]; then
    # The Usage Analysis stack registers DeployerRoleName as a Lake Formation
    # Data Lake Admin so CloudFormation (running as the deploying principal) can
    # create the LF Permissions grants. That role name MUST match the role this
    # deploy actually runs as — otherwise the grants fail with AccessDenied.
    # Resolve it: explicit --deployer-role-name > role parsed from the current
    # caller identity > "Admin" fallback. (Only this stack needs it; the base,
    # Policy Enforcer, and Chat stacks have no deployer-principal coupling.)
    if [[ -z "$deployer_role_name" ]]; then
      local caller_arn
      caller_arn=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo "")
      # arn:aws:sts::<acct>:assumed-role/<RoleName>/<session> -> <RoleName>
      if [[ "$caller_arn" == *":assumed-role/"* ]]; then
        deployer_role_name="${caller_arn#*:assumed-role/}"
        deployer_role_name="${deployer_role_name%%/*}"
      fi
      if [[ -z "$deployer_role_name" ]]; then
        deployer_role_name="Admin"
        echo "  ⚠ Could not derive the deploy role from your caller identity; using DeployerRoleName=Admin."
        echo "    If deploying with a non-admin role (or a role that uses an IAM path), pass"
        echo "    --deployer-role-name <RoleName> so Lake Formation grants succeed."
      else
        echo "  Registering deploy role '$deployer_role_name' as Lake Formation Data Lake Admin."
      fi
    else
      echo "  Registering deploy role '$deployer_role_name' as Lake Formation Data Lake Admin."
    fi

    deploy_stack_checked CapabilityInsightsUsageAnalysis \
      --template-file "$SCRIPT_DIR/dist/template/usage-analysis.template.json" \
      --parameter-overrides \
        WebsiteBucketName="$website_bucket" \
        WebsiteBucketArn="$website_bucket_arn" \
        DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
        LambdaCodeZipPath="$lambda_key" \
        CloudTrailBucketName="${cloudtrail_bucket:-}" \
        DeployerRoleName="$deployer_role_name" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-cli-pager
    echo "  ✓ Usage Analysis stack deployed."

    # Get outputs from Usage Analysis stack
    local analysis_state_machine_arn cloudtrail_analyzer_lambda_name cloudformation_analyzer_lambda_name usage_decorator_lambda_name
    analysis_state_machine_arn=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsUsageAnalysis \
      --query "Stacks[0].Outputs[?OutputKey=='AnalysisStateMachineArn'].OutputValue" --output text 2>/dev/null || echo "")
    cloudtrail_analyzer_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsUsageAnalysis \
      --query "Stacks[0].Outputs[?OutputKey=='CloudTrailAnalyzerLambdaName'].OutputValue" --output text 2>/dev/null || echo "")
    cloudformation_analyzer_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsUsageAnalysis \
      --query "Stacks[0].Outputs[?OutputKey=='CloudFormationAnalyzerLambdaName'].OutputValue" --output text 2>/dev/null || echo "")
    usage_decorator_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsUsageAnalysis \
      --query "Stacks[0].Outputs[?OutputKey=='UsageDecoratorLambdaName'].OutputValue" --output text 2>/dev/null || echo "")

    # Force Lambda code update (CloudFormation may skip if template is unchanged)
    if [[ -n "$cloudtrail_analyzer_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$cloudtrail_analyzer_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true
    fi
    if [[ -n "$cloudformation_analyzer_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$cloudformation_analyzer_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true
    fi
    if [[ -n "$usage_decorator_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$usage_decorator_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true
    fi

    if [[ -n "$analysis_state_machine_arn" && -n "$cloudtrail_analyzer_lambda_name" && -n "$cloudformation_analyzer_lambda_name" ]]; then
      echo "── Updating Insights stack with Usage Analysis outputs ──"
      deploy_stack_checked CapabilityInsightsForAWS \
        --template-file "$SCRIPT_DIR/dist/template/capability-insights.template.json" \
        --parameter-overrides \
          PrivateVpcId="$private_vpc_id" \
          BackendSubnetId="$backend_subnet_id" \
          ApiAccessSubnetId="$api_access_subnet_id" \
          DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
          DeploymentAssetsBucketApiLambdaFunctionCodeZipPath="$lambda_key" \
          SourceAccessPointArn="$source_access_point_arn" \
          SourceFolders="$source_folders" \
          AnalysisStateMachineArn="$analysis_state_machine_arn" \
          CloudTrailAnalyzerLambdaName="$cloudtrail_analyzer_lambda_name" \
          CloudFormationAnalyzerLambdaName="$cloudformation_analyzer_lambda_name" \
          ConfiguredCloudTrailBucketName="$cloudtrail_bucket" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-cli-pager
      echo "  ✓ Insights stack updated with analysis integration."
    fi

    # Auto-trigger the first account analysis so opting in via
    # --enable-usage-analysis produces personalized data without the user
    # having to discover the Settings → "Run analysis" button. Mirrors the
    # post-deploy data sync below. Fire-and-forget: the state machine runs
    # asynchronously (analyzers + decorator take several minutes), and the
    # dashboard surfaces progress via the "Last analysis" sync indicator.
    if [[ -n "$analysis_state_machine_arn" ]]; then
      echo "── Triggering initial account analysis ──"
      local analysis_input
      analysis_input=$(cat <<JSON
{
  "scope": "account",
  "accounts": ["${ACCOUNT_ID}"],
  "analyzers": ["cloudtrail", "cloudformation"],
  "cloudTrailBucket": "${cloudtrail_bucket:-}",
  "cloudTrailPrefix": "AWSLogs/",
  "daysToScan": 30,
  "websiteBucket": "${website_bucket}",
  "cloudtrailAnalyzerLambda": "${cloudtrail_analyzer_lambda_name:-}",
  "cloudformationAnalyzerLambda": "${cloudformation_analyzer_lambda_name:-}"
}
JSON
)
      if aws stepfunctions start-execution \
        --state-machine-arn "$analysis_state_machine_arn" \
        --input "$analysis_input" > /dev/null 2>&1; then
        echo "  ✓ Account analysis started (runs in the background; check the dashboard's \"Last analysis\" indicator)."
      else
        echo "  ⚠ Could not auto-start analysis. Trigger it manually from Settings → Run analysis."
      fi
    fi
  else
    echo "  Skipped (pass --enable-usage-analysis to deploy)."
  fi

  echo "── Deploying Policy Enforcer stack ──"
  local policy_table_name=""
  if [[ "$enable_policy_enforcer" == "true" ]]; then
    deploy_stack_checked CapabilityInsightsPolicyEnforcer \
      --template-file "$SCRIPT_DIR/dist/template/policy-enforcer.template.json" \
      --parameter-overrides \
        DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
        LambdaCodeZipPath="$lambda_key" \
        PrivateVpcId="$private_vpc_id" \
        BackendSubnetId="$backend_subnet_id" \
        WebsiteBucketName="$website_bucket" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-cli-pager
    echo "  ✓ Policy Enforcer stack deployed."

    policy_table_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsPolicyEnforcer \
      --query "Stacks[0].Outputs[?OutputKey=='PolicyTableName'].OutputValue" --output text 2>/dev/null || echo "")
    local iam_helper_lambda_name policy_refresh_lambda_name
    iam_helper_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsPolicyEnforcer \
      --query "Stacks[0].Outputs[?OutputKey=='IamHelperLambdaName'].OutputValue" --output text 2>/dev/null || echo "")
    policy_refresh_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsPolicyEnforcer \
      --query "Stacks[0].Outputs[?OutputKey=='PolicyRefreshLambdaName'].OutputValue" --output text 2>/dev/null || echo "")

    # Force-update both Lambdas' code (CFN may skip if template is unchanged)
    if [[ -n "$iam_helper_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$iam_helper_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true
    fi
    if [[ -n "$policy_refresh_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$policy_refresh_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true
    fi

    if [[ -n "$policy_table_name" ]]; then
      echo "── Updating Insights stack with Policy Enforcer outputs ──"
      # Re-run the main stack deploy with PolicyTableName plus any
      # already-discovered Usage Analysis outputs so we don't lose them.
      deploy_stack_checked CapabilityInsightsForAWS \
        --template-file "$SCRIPT_DIR/dist/template/capability-insights.template.json" \
        --parameter-overrides \
          PrivateVpcId="$private_vpc_id" \
          BackendSubnetId="$backend_subnet_id" \
          ApiAccessSubnetId="$api_access_subnet_id" \
          DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
          DeploymentAssetsBucketApiLambdaFunctionCodeZipPath="$lambda_key" \
          SourceAccessPointArn="$source_access_point_arn" \
          SourceFolders="$source_folders" \
          AnalysisStateMachineArn="${analysis_state_machine_arn:-}" \
          CloudTrailAnalyzerLambdaName="${cloudtrail_analyzer_lambda_name:-}" \
          CloudFormationAnalyzerLambdaName="${cloudformation_analyzer_lambda_name:-}" \
          ConfiguredCloudTrailBucketName="${cloudtrail_bucket:-}" \
          PolicyTableName="$policy_table_name" \
          IamHelperLambdaName="${iam_helper_lambda_name:-}" \
          PolicyRefreshLambdaName="${policy_refresh_lambda_name:-}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-cli-pager
      echo "  ✓ Insights stack updated with Policy Enforcer integration."
    fi
  else
    echo "  Skipped (pass --enable-policy-enforcer to deploy)."
  fi

  echo "── Deploying Chat assistant stack ──"
  if [[ "$enable_chat" == "true" ]]; then
    local model_id="${bedrock_model_id:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"
    # Preflight: warn early if account-level Bedrock model access isn't enabled
    # (the stack grants invoke permission but can't enable the model itself).
    check_bedrock_access "$model_id" "$REGION"
    deploy_stack_checked CapabilityInsightsChat \
      --template-file "$SCRIPT_DIR/dist/template/chat.template.json" \
      --parameter-overrides \
        DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
        LambdaCodeZipPath="$lambda_key" \
        WebsiteBucketName="$website_bucket" \
        PolicyTableName="${policy_table_name:-}" \
        BedrockModelId="$model_id" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-cli-pager
    echo "  ✓ Chat stack deployed."

    local chat_lambda_name
    chat_lambda_name=$(aws cloudformation describe-stacks \
      --stack-name CapabilityInsightsChat \
      --query "Stacks[0].Outputs[?OutputKey=='ChatLambdaName'].OutputValue" --output text 2>/dev/null || echo "")

    # Force-update the Chat Lambda's code (CFN may skip if template unchanged).
    if [[ -n "$chat_lambda_name" ]]; then
      aws lambda update-function-code \
        --function-name "$chat_lambda_name" \
        --s3-bucket "$deployment_assets_bucket_name" \
        --s3-key "$lambda_key" > /dev/null 2>&1 || true

      echo "── Updating Insights stack with Chat output ──"
      # Re-run the main stack with ChatLambdaName plus any already-discovered
      # Usage Analysis / Policy Enforcer outputs so we don't lose them. Empty
      # vars are passed through as "" (their HasX condition stays false).
      deploy_stack_checked CapabilityInsightsForAWS \
        --template-file "$SCRIPT_DIR/dist/template/capability-insights.template.json" \
        --parameter-overrides \
          PrivateVpcId="$private_vpc_id" \
          BackendSubnetId="$backend_subnet_id" \
          ApiAccessSubnetId="$api_access_subnet_id" \
          DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
          DeploymentAssetsBucketApiLambdaFunctionCodeZipPath="$lambda_key" \
          SourceAccessPointArn="$source_access_point_arn" \
          SourceFolders="$source_folders" \
          AnalysisStateMachineArn="${analysis_state_machine_arn:-}" \
          CloudTrailAnalyzerLambdaName="${cloudtrail_analyzer_lambda_name:-}" \
          CloudFormationAnalyzerLambdaName="${cloudformation_analyzer_lambda_name:-}" \
          ConfiguredCloudTrailBucketName="${cloudtrail_bucket:-}" \
          PolicyTableName="${policy_table_name:-}" \
          IamHelperLambdaName="${iam_helper_lambda_name:-}" \
          PolicyRefreshLambdaName="${policy_refresh_lambda_name:-}" \
          ChatLambdaName="$chat_lambda_name" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-cli-pager
      echo "  ✓ Insights stack updated with Chat integration."
    fi
  else
    echo "  Skipped (pass --enable-chat to deploy)."
  fi

  echo "── Syncing capability data ──"
  aws lambda invoke --function-name CapabilityInsightsDataFetchLambda --invocation-type Event /dev/null > /dev/null 2>&1

  echo ""
  echo "✓ Deployment complete"
  echo ""
  echo "Website URL (accessible from within your VPC):"
  echo "  http://${website_bucket}.s3-website-${REGION}.amazonaws.com"
}

cmd_teardown() {
  echo "── Capability Insights — Teardown ──"

  get_account_and_region
  local website_bucket="capability-insights-website-${ACCOUNT_ID}-${REGION}"

  if [[ "$AUTO_APPROVE" != "true" ]]; then
    echo "This will delete the CapabilityInsightsForAWS, CapabilityInsightsUsageAnalysis, CapabilityInsightsPolicyEnforcer, and CapabilityInsightsChat stacks and empty the website bucket."
    read -rp "Continue? (y/N): " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
  fi

  echo "── Emptying website bucket ──"
  aws s3 rm "s3://$website_bucket" --recursive || true

  echo "── Destroying Chat stack ──"
  aws cloudformation delete-stack --stack-name CapabilityInsightsChat 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name CapabilityInsightsChat 2>/dev/null || true
  echo "  ✓ Chat stack deleted."

  echo "── Destroying Policy Enforcer stack ──"
  aws cloudformation delete-stack --stack-name CapabilityInsightsPolicyEnforcer 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name CapabilityInsightsPolicyEnforcer 2>/dev/null || true
  echo "  ✓ Policy Enforcer stack deleted."

  echo "── Destroying Usage Analysis stack ──"
  aws cloudformation delete-stack --stack-name CapabilityInsightsUsageAnalysis 2>/dev/null || true
  aws cloudformation wait stack-delete-complete --stack-name CapabilityInsightsUsageAnalysis 2>/dev/null || true
  echo "  ✓ Usage Analysis stack deleted."

  echo "── Destroying stack (this will likely take ~15 minutes) ──"
  aws cloudformation delete-stack --stack-name CapabilityInsightsForAWS
  local elapsed=0
  local status="DELETE_IN_PROGRESS"
  while true; do
    if (( elapsed % 15 == 0 )); then
      status=$(aws cloudformation describe-stacks --stack-name CapabilityInsightsForAWS \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null) || break
      [[ "$status" == *"COMPLETE"* || "$status" == *"FAILED"* ]] && break
    fi
    printf "\r  ⏳ %s (%dm %ds elapsed)" "$status" $((elapsed/60)) $((elapsed%60))
    sleep 1
    elapsed=$((elapsed + 1))
  done
  printf "\r  ✓ Stack deleted.%30s\n" ""

  echo ""
  echo "✓ Teardown complete"
}

COMMAND="${1:-}"
shift || true

AUTO_APPROVE=""
for arg in "$@"; do
  [[ "$arg" == "-y" || "$arg" == "--yes" ]] && AUTO_APPROVE="true"
done

case "$COMMAND" in
  deploy)   cmd_deploy "$@" ;;
  teardown) cmd_teardown ;;
  *)        usage ;;
esac
