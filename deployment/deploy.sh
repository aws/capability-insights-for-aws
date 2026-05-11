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
  --enable-usage-analysis                Deploy the Usage Analysis stack (requires --cloudtrail-bucket)
  --cloudtrail-bucket <name>             S3 bucket containing CloudTrail logs (for usage analysis)
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

cmd_deploy() {
  local private_vpc_id="" backend_subnet_id="" api_access_subnet_id="" deployment_assets_bucket_name="" source_access_point_arn="" source_folders="" cloudtrail_bucket="" enable_usage_analysis="" auto_approve=""

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
    aws cloudformation deploy \
      --template-file "$SCRIPT_DIR/dist/template/usage-analysis.template.json" \
      --stack-name CapabilityInsightsUsageAnalysis \
      --parameter-overrides \
        WebsiteBucketName="$website_bucket" \
        WebsiteBucketArn="$website_bucket_arn" \
        DeploymentAssetsBucketName="$deployment_assets_bucket_name" \
        LambdaCodeZipPath="$lambda_key" \
        CloudTrailBucketName="${cloudtrail_bucket:-}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-cli-pager || true
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
          AnalysisStateMachineArn="$analysis_state_machine_arn" \
          CloudTrailAnalyzerLambdaName="$cloudtrail_analyzer_lambda_name" \
          CloudFormationAnalyzerLambdaName="$cloudformation_analyzer_lambda_name" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-cli-pager || true
      echo "  ✓ Insights stack updated with analysis integration."
    fi
  else
    echo "  Skipped (pass --enable-usage-analysis to deploy)."
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
    echo "This will delete the CapabilityInsightsForAWS and CapabilityInsightsUsageAnalysis stacks and empty the website bucket."
    read -rp "Continue? (y/N): " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
  fi

  echo "── Emptying website bucket ──"
  aws s3 rm "s3://$website_bucket" --recursive || true

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
