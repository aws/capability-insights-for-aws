#!/bin/bash
REQUIRED_DEPS=(aws node npx)

missing=()
for cmd in "${REQUIRED_DEPS[@]}"; do
  command -v "$cmd" &>/dev/null || missing+=("$cmd")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: missing required dependencies: ${missing[*]}"
  exit 1
fi

CALLER_IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || {
  echo "Error: AWS credentials are invalid or expired. Refresh them and try again."
  exit 1
}
AWS_ACCOUNT=$(echo "$CALLER_IDENTITY" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
# Prefer the AWS_REGION / AWS_DEFAULT_REGION env vars (which the AWS CLI honors
# but `aws configure get region` does not read), then the configured region,
# then a commercial default. Isolated-partition users set the env var, so the
# us-east-1 fallback only applies when nothing at all is configured.
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo "us-east-1")}}"
# Export it so every downstream `aws`/`cdk` call (in deploy.sh and dev.sh, which
# both source this file) inherits the region instead of failing with "You must
# specify a region" when it is only set here as a shell variable.
export AWS_DEFAULT_REGION="$AWS_REGION"
echo "── AWS: account $AWS_ACCOUNT, region $AWS_REGION ──"
