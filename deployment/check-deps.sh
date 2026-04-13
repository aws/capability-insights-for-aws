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
AWS_REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
echo "── AWS: account $AWS_ACCOUNT, region $AWS_REGION ──"
