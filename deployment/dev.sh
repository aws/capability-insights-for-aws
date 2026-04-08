#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/check-deps.sh"
STACK_NAME="CapabilityInsightsSampleEnvironment"

usage() {
  cat <<EOF
Usage: $0 <command> [options]

Commands:
  setup       Deploy the CapabilityInsightsSampleEnvironment (Example VPC/Subnet environment)
  deploy      Build and deploy Capability Insights using CapabilityInsightsSampleEnvironment outputs
  teardown    Remove both stacks

Setup options:
  --ec2-key-pair <name>   EC2 key pair name (optional)

Deploy options:
  --source-access-point-arn <arn>  S3 access point ARN for capability data source
  --source-folders <folders>       Comma-separated list of source folders (default: public)

Global options:
  -y, --yes                        Skip confirmation prompts

EOF
  exit 1
}

get_stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

cmd_setup() {
  local key_pair=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --ec2-key-pair) key_pair="$2"; shift 2 ;;
      *) echo "Unknown option: $1"; usage ;;
    esac
  done

  echo "── Deploying CapabilityInsightsSampleEnvironment ──"
  cd "$ROOT_DIR/source/constructs"

  local context_args=""
  if [[ -n "$key_pair" ]]; then
    context_args="-c ec2KeyPair=$key_pair"
  fi

  npx cdk bootstrap
  npx cdk --app "node dist/bin/dev" deploy "$STACK_NAME" \
    $context_args --require-approval never

  echo ""
  echo "✓ CapabilityInsightsSampleEnvironment deployed"
}

cmd_deploy() {
  local source_access_point_arn="" source_folders=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --source-access-point-arn) source_access_point_arn="$2"; shift 2 ;;
      --source-folders) source_folders="$2"; shift 2 ;;
      -y|--yes) shift ;;
      *) echo "Unknown option: $1"; usage ;;
    esac
  done

  echo "── Reading CapabilityInsightsSampleEnvironment outputs ──"
  local private_vpc_id=$(get_stack_output "PrivateVpcId")
  local backend_subnet_id=$(get_stack_output "BackendSubnetId")
  local api_access_subnet_id=$(get_stack_output "ApiAccessSubnetId")
  local deployment_assets_bucket_name=$(get_stack_output "DeploymentAssetsBucketName")

  if [[ -z "$private_vpc_id" || -z "$backend_subnet_id" || -z "$api_access_subnet_id" || -z "$deployment_assets_bucket_name" ]]; then
    echo "Error: Could not read CapabilityInsightsSampleEnvironment outputs. Run '$0 setup' first."
    exit 1
  fi

  echo "  PrivateVpcId:             $private_vpc_id"
  echo "  BackendSubnetId:          $backend_subnet_id"
  echo "  ApiAccessSubnetId:        $api_access_subnet_id"
  echo "  DeploymentAssetsBucketName: $deployment_assets_bucket_name"
  echo ""

  local access_point_args=()
  if [[ -n "$source_access_point_arn" ]]; then
    access_point_args+=(--source-access-point-arn "$source_access_point_arn")
  fi
  if [[ -n "$source_folders" ]]; then
    access_point_args+=(--source-folders "$source_folders")
  fi

  "$SCRIPT_DIR/deploy.sh" deploy \
    --private-vpc-id "$private_vpc_id" \
    --backend-subnet-id "$backend_subnet_id" \
    --api-access-subnet-id "$api_access_subnet_id" \
    --deployment-assets-bucket-name "$deployment_assets_bucket_name" \
    "${access_point_args[@]}" \
    ${AUTO_APPROVE:+--yes}
}

cmd_teardown() {
  echo "── Dev Teardown ──"

  "$SCRIPT_DIR/deploy.sh" teardown ${AUTO_APPROVE:+--yes}

  echo "── Emptying assets bucket ──"
  local account_id=$(aws sts get-caller-identity --query Account --output text)
  local region=$(aws configure get region || echo "us-east-1")
  local assets_bucket="capability-insights-assets-${account_id}-${region}"
  aws s3 rm "s3://$assets_bucket" --recursive || true

  echo "── Destroying CapabilityInsightsSampleEnvironment ──"
  cd "$ROOT_DIR/source/constructs"
  npx cdk --app "node dist/bin/dev" destroy "$STACK_NAME" --force

  echo ""
  echo "✓ Dev teardown complete"
}

COMMAND="${1:-}"
shift || true

AUTO_APPROVE=""
for arg in "$@"; do
  [[ "$arg" == "-y" || "$arg" == "--yes" ]] && AUTO_APPROVE="true"
done

case "$COMMAND" in
  setup)    cmd_setup "$@" ;;
  deploy)   cmd_deploy "$@" ;;
  teardown) cmd_teardown ;;
  *)        usage ;;
esac
