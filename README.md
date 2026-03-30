# Capability Insights for AWS

Capability Insights for AWS is a self-deployable solution that stands up an application in your AWS account to browse regional availability data from [AWS Capability by Region](https://builder.aws.com/build/capabilities).

## Overview

AWS Capability by Region tracks which AWS services, features, API operations, and CloudFormation resource types are available in each AWS region. It offers a [public website](https://builder.aws.com/build/capabilities) for commercial regions, and also provides data through S3 buckets for both public and non-public partitions. Enterprise customers in non-commercial partitions can onboard to receive additional data. This solution pulls from those S3 sources, merges the data, and presents it through a searchable dashboard deployed into your VPC.

The dashboard covers three categories of Capability:

- **Services and features**: which AWS services and features are available, planned, or not expanding per region, with expected launch dates
- **API operations**: individual API action availability per region for each AWS service SDK
- **CloudFormation resource types**: which resource types are supported in each region

Data refreshes automatically every 24 hours and can also be triggered on demand.

### Solution Architecture

![High-level architecture](docs/images/high-level-architecture.png)

The solution assumes you have an existing VPC with two subnets (one with an internet gateway, one without), plus an S3 bucket to hold deployment assets.

This repository provides two CloudFormation stacks:

#### 1. Capability Insights Stack

The core solution. It deploys a website and API into your VPC, along with a Lambda function that periodically pulls capability data from the AWS Capability by Region S3 bucket and makes it available through the website. Data refreshes every 24 hours and can also be triggered on demand.

| Resource                   | Description                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- |
| S3 Bucket                  | Hosts the static website and capability data                                        |
| API Gateway                | REST API accessible via VPC Endpoint                                                |
| API Gateway VPC Endpoint   | Allows the website to reach the API from within the VPC                             |
| API Lambda                 | Handles API requests from the website, runs in the subnet without internet access   |
| DataFetch Lambda           | Pulls capability data from the source S3 bucket and writes it to the website bucket |
| Lambda Invoke VPC Endpoint | Allows the API Lambda to invoke the DataFetch Lambda without internet access        |
| EventBridge Rule           | Triggers the DataFetch Lambda every 24 hours                                        |
| S3 Gateway Endpoint        | Allows the website bucket to be accessed from within the VPC                        |

#### 2. CapabilityInsightsSampleEnvironment Stack (optional)

A development scaffold for testing when you don't have an existing environment to deploy into.

| Resource                  | Description                                       |
| ------------------------- | ------------------------------------------------- |
| VPC                       | VPC with DNS resolution and DNS hostnames enabled |
| Subnet (with internet)    | Subnet with an Internet Gateway for user access   |
| Subnet (without internet) | Isolated subnet for backend compute               |
| S3 Gateway Endpoint       | Allows instances to access S3 from within the VPC |
| S3 Bucket                 | Deployment assets bucket for Lambda code          |
| EC2 Instance (Linux)      | Amazon Linux 2023 instance for testing            |
| IAM Role                  | Instance role with SSM and S3 access              |

Users access the website from within the VPC, for example through an EC2 instance or AWS Client VPN.

### Package Structure

This project uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) to manage four packages under `source/`. Running `npm run build` from the root builds all packages in the correct order, and shared dependencies are hoisted to the root `node_modules/`.

```
├── deployment/              # Deployment and dev scripts
│   ├── deploy.sh            # Deploy/teardown the Capability Insights stack
│   ├── dev.sh               # Deploy/teardown the CapabilityInsightsSampleEnvironment stack
│   └── check-deps.sh        # Validates required CLI tools (aws, node, npx)
├── docs/                    # Documentation assets
├── source/
│   ├── shared/              # Shared TypeScript types
│   ├── lambda/              # Lambda function code
│   ├── constructs/          # CDK infrastructure
│   └── website/             # React frontend
└── package.json             # Root workspace configuration
```

#### `source/constructs`

CDK application that defines the two CloudFormation stacks.

Many enterprise customers do not use CDK, so we use CDK as a development tool to produce a standard CloudFormation template that can be deployed in any environment. On build, it synthesizes the Capability Insights stack, strips CDK metadata, and writes the clean template to `deployment/dist/template/`. The CapabilityInsightsSampleEnvironment stack is used directly via `cdk deploy` during development.

#### `source/lambda`

Contains relevant backend lambda code:

- **API Lambda** (`api-lambda-main.ts`): Backs the API Gateway and routes requests from the website.
- **DataFetch Lambda** (`data-fetch-lambda-main.ts`): Reads capability data from the source S3 access point, merges data across multiple source folders, and writes the results to the website bucket in both JSON and CSV formats.

API endpoints:

| Method | Endpoint              | Body | Description                                                         |
| ------ | --------------------- | ---- | ------------------------------------------------------------------- |
| POST   | `/syncCapabilityData` | None | Triggers an asynchronous data fetch from the source S3 access point |

#### `source/website`

A React dashboard built with [Cloudscape Design System](https://cloudscape.design/) to visualize the capability data.

## Installation

### Prerequisites

**Your computer:**

- [Node.js](https://nodejs.org/) (includes `npm` and `npx`)
- [AWS CLI](https://aws.amazon.com/cli/) configured with valid credentials

**Your AWS account:**

- A VPC with DNS resolution and DNS hostnames enabled
- Two subnets in that VPC: one with an internet gateway (for user access and the API Gateway VPC Endpoint), one without (for Lambda compute)
- An S3 access point ARN for the capability data source (provided during onboarding)

### Deploy

> **Region**: The solution deploys to whichever AWS region is configured in your CLI profile. To check your current region, run:
>
> ```bash
> aws configure get region
> ```
>
> To deploy to a different region, either set it in your profile (`aws configure set region <REGION>`) or export the `AWS_DEFAULT_REGION` environment variable before running the deploy script.

1. Create an S3 bucket for deployment assets with public access blocked. We recommend naming it `capability-insights-assets-<ACCOUNT_ID>-<REGION>`.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the deploy script:

   ```bash
   npm run deploy
   ```

   The script builds all assets, prompts for parameters, deploys the CloudFormation stack, uploads the website, and triggers an initial data sync. You will be prompted for a `SourceAccessPointArn` — this is the S3 access point ARN for the capability data source bucket, provided to you during onboarding. You will also be prompted for `SourceFolders` — a comma-separated list of folder names in the access point to fetch data from (defaults to `public`).

### Deploy Flags

All parameters can be passed as flags to skip the interactive prompts:

```bash
npm run deploy -- \
  --private-vpc-id vpc-0abc123 \
  --backend-subnet-id subnet-0abc123 \
  --api-access-subnet-id subnet-0def456 \
  --deployment-assets-bucket-name my-deploy-bucket \
  --source-access-point-arn arn:aws:s3:us-east-1:123456789012:accesspoint/my-access-point \
  --source-folders public
```

| Flag                              | Description                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--private-vpc-id`                | VPC ID. Must have DNS resolution and DNS hostnames enabled.                                      |
| `--backend-subnet-id`             | Subnet without an internet gateway, where the Lambda functions run.                              |
| `--api-access-subnet-id`          | Subnet where users access the website from. The API Gateway VPC Endpoint is created here.        |
| `--deployment-assets-bucket-name` | S3 bucket for deployment assets (Lambda code zip).                                               |
| `--source-access-point-arn`       | S3 access point ARN for the capability data source (provided during onboarding).                 |
| `--source-folders`                | Comma-separated list of folder names in the access point to fetch data from (default: `public`). |

### Teardown

```bash
npm run teardown
```

This deletes the CloudFormation stack and empties the website S3 bucket.

### Accessing the Website

The website is accessible from within your VPC. Connect through a client in the VPC (e.g. an EC2 instance, AWS Client VPN) and navigate to:

```
http://capability-insights-website-<ACCOUNT_ID>-<REGION>.s3-website-<REGION>.amazonaws.com
```

The deploy script prints this URL on completion.

### Manual Installation

If you prefer to deploy without running the deploy script, download `build-assets.zip` from the [latest release](https://github.com/aws/capability-insights-for-aws/releases/latest) and extract it. It contains:

- `lambda/lambdaAssets.zip` — Lambda function code
- `template/capability-insights.template.json` — CloudFormation template
- `website/` — compiled website files

Then follow these steps:

1. Upload the Lambda code to your deployment assets bucket:

   ```bash
   aws s3 cp lambda/lambdaAssets.zip s3://<DEPLOYMENT_ASSETS_BUCKET>/lambdaAssets.zip
   ```

2. Deploy the CloudFormation stack:

   ```bash
   aws cloudformation deploy \
     --template-file template/capability-insights.template.json \
     --stack-name CapabilityInsightsForAWS \
     --capability CAPABILITY_IAM CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       PrivateVpcId=<VPC_ID> \
       BackendSubnetId=<BACKEND_SUBNET_ID> \
       ApiAccessSubnetId=<API_ACCESS_SUBNET_ID> \
       DeploymentAssetsBucketName=<DEPLOYMENT_ASSETS_BUCKET> \
       DeploymentAssetsBucketApiLambdaFunctionCodeZipPath=lambdaAssets.zip \
       SourceAccessPointArn=<SOURCE_ACCESS_POINT_ARN> \
       SourceFolders=<SOURCE_FOLDERS>
   ```

3. Upload the website assets:

   ```bash
   aws s3 sync website/ \
     s3://capability-insights-website-<ACCOUNT_ID>-<REGION>/
   ```

4. Trigger the initial data sync:

   ```bash
   aws lambda invoke \
     --function-name CapabilityInsightsDataFetchLambda \
     --invocation-type Event /dev/null
   ```

## Development

The CapabilityInsightsSampleEnvironment stack provisions a VPC, subnets, an EC2 instance, and a deployment assets bucket for testing.

To access the EC2 instance via SSH, first generate a key pair and import the public key into EC2:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ci-key
aws ec2 import-key-pair --key-name ci-key --public-key-material fileb://~/.ssh/ci-key.pub
```

Then build and deploy the stacks:

```bash
# Install dependencies
npm install

# Deploy the CapabilityInsightsSampleEnvironment stack (optionally pass --ec2-key-pair <name>)
npm run dev:setup -- --ec2-key-pair ci-key

# Deploy Capability Insights using the CapabilityInsightsSampleEnvironment outputs
npm run dev:deploy
```

### Available Scripts

| Command                | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `npm run build`        | Build all assets (Lambda, CloudFormation template, website)     |
| `npm run deploy`       | Build and deploy to an existing VPC (interactive or with flags) |
| `npm run teardown`     | Remove the deployed stack and website assets                    |
| `npm run dev:setup`    | Deploy the CapabilityInsightsSampleEnvironment stack            |
| `npm run dev:deploy`   | Deploy using CapabilityInsightsSampleEnvironment stack outputs  |
| `npm run dev:teardown` | Tear down both stacks                                           |
| `npm run clean`        | Remove all build artifacts and node_modules                     |
| `npm run server`       | Start the website dev server locally                            |

### Accessing the Website from Your Machine

The website is only accessible from within the VPC. To browse it from your local machine, set up a SOCKS5 proxy through an EC2 instance in the VPC.

First, find your EC2 instance's public IP address:

1. Go to the AWS EC2 Console
2. Select the instance created by the CapabilityInsightsSampleEnvironment stack
3. Copy the Public IPv4 address from the instance details

```bash
ssh -D 8080 -N -i ~/.ssh/ci-key ec2-user@<EC2_INSTANCE_PUBLIC_IP>
```

Launch Chrome using that proxy:

**On macOS:**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --proxy-server="socks5://localhost:8080" \
  --user-data-dir="/tmp/chrome-proxy"
```

**On Windows:**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --proxy-server="socks5://localhost:8080" ^
  --user-data-dir="%TEMP%\chrome-proxy"
```

Finally, navigate to the website URL printed by the deploy script:

```
http://capability-insights-website-<ACCOUNT_ID>-<REGION>.s3-website-<REGION>.amazonaws.com
```

## License

This project is licensed under the Apache-2.0 License. See the [LICENSE](LICENSE) file.
