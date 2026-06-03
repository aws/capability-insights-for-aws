# Capability Insights for AWS

[![Build](https://github.com/aws/capability-insights-for-aws/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/aws/capability-insights-for-aws/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/aws/capability-insights-for-aws)](https://github.com/aws/capability-insights-for-aws/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Deploy a regional availability dashboard into your own AWS account, powered by data from [AWS Capabilities By Region](https://builder.aws.com/build/capabilities).

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
  - [Data Layer Onboarding](#data-layer-onboarding)
- [Accessing the Website](#accessing-the-website)
- [User Guide](#user-guide)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

## Overview

[AWS Capabilities By Region](https://builder.aws.com/build/capabilities) helps you discover and compare AWS services, features, APIs, and CloudFormation resources across regions. With detailed availability data and forward-looking roadmap information, you can make informed decisions about global deployments and avoid project delays. You can explore this data on our [public website](https://builder.aws.com/build/capabilities), which covers over 35 regions across the commercial, AWS GovCloud (US), and European Sovereign Cloud partitions.

This open-source solution builds on top of AWS Capabilities By Region by deploying a searchable dashboard into your own AWS account. Data is pulled directly into your AWS account, accessible inside your own VPC, and refreshes automatically every 24 hours. If your organization has been granted access to additional data sources beyond what's publicly available, this solution can incorporate those as well, giving you a unified view across all [partitions](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference-arns.html) you have access to. To learn more about accessing additional data, work with your AWS representative.

The dashboard covers:

- **Services and features** — availability status, expected launch dates, and expansion plans per region
- **API operations** — individual API action availability per region for each AWS service
- **CloudFormation resource types** — which resource types are supported in each region
- **Personalized usage (opt-in)** — a "My Stuff" view that filters everything down to services, APIs, and resources actually used in your account, derived from CloudTrail and CloudFormation

![Dashboard overview](docs/images/dashboard-overview.png)

The solution deploys entirely within your VPC so that all data remains within your network. You provide your own VPC, subnets, and S3 bucket so the solution integrates with your existing infrastructure and security controls.

### Solution Architecture

![High-level architecture](docs/images/high-level-architecture.png)

The solution deploys a static website, REST API, and Lambda functions into your VPC. Personalization is provided by an opt-in second stack that adds a Step Functions state machine and analyzer Lambdas that read your account's CloudTrail logs and CloudFormation stacks.

![Usage Analysis architecture](docs/images/personalization-architecture.png)

For a detailed breakdown of all resources, see [Architecture](#architecture).

## Installation

Capability Insights for AWS consists of a CloudFormation stack, Lambda function code, and a static website. You can deploy these using our automated script, which builds and deploys everything in one step. If your organization requires deploying with native AWS tooling only, you can download pre-built artifacts from our [GitHub Releases](https://github.com/aws/capability-insights-for-aws/releases/latest) and deploy them directly with the AWS CLI.

### Prerequisites

**On your machine:**

- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials for the target AWS account

**In your AWS account:**

Capability Insights for AWS deploys into your existing network infrastructure. You will need the following in the AWS account and region where you want the dashboard accessible:

| Resource                            | Description                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| VPC                                 | The VPC where you want the dashboard deployed. Must have DNS resolution enabled.    |
| └ Subnet (with internet gateway)    | Users access the dashboard from this subnet.                                        |
| └ Subnet (without internet gateway) | Lambda functions run here securely with no direct internet access.                  |
| S3 access point ARN                 | How the solution reads capability data from the source. Provided during onboarding. |

If you don't have an existing VPC and subnets to deploy into, we provide a [Sample Environment Stack](#sample-environment-stack-optional) that creates these resources for you.

The solution deploys to whichever region is configured in your AWS CLI profile. To check your current region, run `aws configure get region`. To change it, run `aws configure set region <REGION>`.

### Data Layer Onboarding

**PUBLIC:** No onboarding is required to access the public data set (regional availability data set for commercial regions). Use the following S3 access point ARN: `arn:aws:s3:us-east-1:686591367145:accesspoint/aws-capabilities-public`

**PREVIEW:** For PREVIEW (Internal and in-build regions) onboarding, please connect with your AWS Account Team to prepare the required authorization documents and cut a ticket with the documents attached. The team will then review and initiate the onboarding process.

### Automated Installation

In addition to the prerequisites above, you will need [Node.js](https://nodejs.org/) (includes `npm` and `npx`).

1. Clone this repository:

   ```bash
   git clone https://github.com/aws/capability-insights-for-aws.git
   cd capability-insights-for-aws
   ```

2. Create an S3 bucket for deployment assets with public access blocked. This bucket is used exclusively to store the Lambda code package during deployment. We recommend naming it `capability-insights-assets-<ACCOUNT_ID>-<REGION>`.

3. Install dependencies:

   ```bash
   npm install
   ```

4. Run the deploy script:

   ```bash
   npm run deploy
   ```

   The script builds all assets, prompts for parameters, deploys the CloudFormation stack, uploads the website, and triggers an initial data sync.

   You will be prompted for `SourceFolders`, a comma-separated list of data sources to pull from. The default is `public`. If your organization has been granted access to additional [partitions](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference-arns.html), include them as well (e.g., `aws-cn,public`).

Once complete, see [Accessing the Website](#accessing-the-website).

#### Deploy Flags

All parameters can be passed as flags to skip the interactive prompts:

```bash
npm run deploy -- \
  --private-vpc-id vpc-0abc123 \
  --backend-subnet-id subnet-0abc123 \
  --api-access-subnet-id subnet-0def456 \
  --deployment-assets-bucket-name my-deploy-bucket \
  --source-access-point-arn arn:aws:s3:us-east-1:123456789012:accesspoint/my-access-point \
  --source-folders aws-cn,public \
  --enable-usage-analysis
```

| Flag                              | Description                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--private-vpc-id`                | VPC ID. Must have DNS resolution and DNS hostnames enabled.                                                             |
| `--backend-subnet-id`             | Subnet without an internet gateway, used for Lambda compute.                                                            |
| `--api-access-subnet-id`          | Subnet with an internet gateway, used for user access and the API Gateway VPC Endpoint.                                 |
| `--deployment-assets-bucket-name` | S3 bucket where deployment assets (Lambda code zip) are stored.                                                         |
| `--source-access-point-arn`       | S3 access point ARN for the capability data source (provided during onboarding).                                        |
| `--source-folders`                | Comma-separated list of data sources to pull from (default: `public`). Include additional partitions if granted access. |
| `--enable-usage-analysis`         | Deploy the opt-in Usage Analysis stack to enable personalization.                                                       |
| `--cloudtrail-bucket`             | CloudTrail logs bucket used by the analyzer (only with `--enable-usage-analysis`). Auto-discovered if omitted.          |

#### Teardown

> **Warning**: This will empty the website bucket (static assets and capability data) and delete the CloudFormation stack.

```bash
npm run teardown
```

### Manual Installation

For organizations that require deploying with native AWS tooling only, pre-built deployment artifacts are published with each [release](https://github.com/aws/capability-insights-for-aws/releases/latest). This path uses only the AWS CLI and standard CloudFormation. No Node.js, CDK, or build tools needed.

Download `build-assets.zip` from the [latest release](https://github.com/aws/capability-insights-for-aws/releases/latest) and extract it. It contains:

- `lambda/lambdaAssets.zip` : Lambda function code
- `template/capability-insights.template.json` : CloudFormation template
- `website/` : compiled website files ready to upload to S3

Then follow these steps:

1. Create an S3 bucket for deployment assets with public access blocked. This bucket is used exclusively to store the Lambda code package during deployment. We recommend naming it `capability-insights-assets-<ACCOUNT_ID>-<REGION>`.

2. Upload the Lambda code to your deployment assets bucket:

   ```bash
   aws s3 cp lambda/lambdaAssets.zip s3://<DEPLOYMENT_ASSETS_BUCKET>/lambdaAssets.zip
   ```

3. Deploy the CloudFormation stack:

   ```bash
   aws cloudformation deploy \
     --template-file template/capability-insights.template.json \
     --stack-name CapabilityInsightsForAWS \
     --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       PrivateVpcId=<VPC_ID> \
       BackendSubnetId=<BACKEND_SUBNET_ID> \
       ApiAccessSubnetId=<API_ACCESS_SUBNET_ID> \
       DeploymentAssetsBucketName=<DEPLOYMENT_ASSETS_BUCKET> \
       DeploymentAssetsBucketApiLambdaFunctionCodeZipPath=lambdaAssets.zip \
       SourceAccessPointArn=<SOURCE_ACCESS_POINT_ARN> \
       SourceFolders=<SOURCE_FOLDERS>
   ```

4. Upload the website assets:

   ```bash
   aws s3 sync website/ \
     s3://capability-insights-website-<ACCOUNT_ID>-<REGION>/
   ```

5. Trigger the initial data sync:

   ```bash
   aws lambda invoke \
     --function-name CapabilityInsightsDataFetchLambda \
     --invocation-type Event /dev/null
   ```

Once complete, see [Accessing the Website](#accessing-the-website).

## Accessing the Website

The website is hosted on S3 and accessible only from within your VPC. After deployment, navigate to:

```
http://capability-insights-website-<ACCOUNT_ID>-<REGION>.s3-website-<REGION>.amazonaws.com
```

The automated deploy script prints this URL on completion.

Since the website is not publicly accessible, you need a way to reach it from within the VPC. Common options include:

- **Existing VPN or Direct Connect** — if your organization already has connectivity to the VPC, use it directly
- **AWS Client VPN** — set up a [Client VPN endpoint](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html) in the VPC
- **EC2 instance with SOCKS proxy** — SSH into an instance in the VPC and proxy browser traffic through it (see [Accessing the Website from Your Machine](#accessing-the-website-from-your-machine) in the Development section for a step-by-step guide)

## User Guide

Once deployed, the dashboard provides a searchable view of AWS service, API, and CloudFormation resource availability across regions, plus an opt-in personalization layer that filters everything to what your account actually uses. This section walks through the main features.

### Browsing Services and Features

The main page shows all AWS services and features with their availability status across regions. Use the search bar to filter by name, and paginate or sort the columns as needed.

![Services and features](docs/images/user-guide-services-and-features.png)

### Expanding Service Details

Click the arrow next to any service to expand it and see individual feature availability. Each feature shows its status per region, so you can quickly identify gaps.

![Expanded services](docs/images/user-guide-expanded-services.png)

### Understanding Status Values

Click the info icon in the top-right corner to open the help panel. It explains each status value — Available, Planning, Not Expanding — and what date indicators like "2026 Q3" mean.

![Help panel](docs/images/user-guide-help-panel.png)

### Exporting Data

Click the Export button to download the current view as JSON or CSV. This is useful for sharing data with your team or feeding it into other tools.

![Export options](docs/images/user-guide-export.png)

### Navigation and Settings

Open the side navigation to switch between the Capability by Region dashboard and Settings. The Settings page lets you trigger a manual data refresh and, when personalization is enabled, run usage analysis on demand.

![Navigation](docs/images/user-guide-navigation.png)

![Settings](docs/images/user-guide-settings.png)

### Personalizing the dashboard (opt-in)

If you deployed with `--enable-usage-analysis`, the dashboard offers a **My stuff** toggle in the Capability by Region page header. With it on, the table filters down to only the services, APIs, and CloudFormation resources actually used in your account.

![My stuff toggle](docs/images/user-guide-personalization-toggle.png)

The CloudFormation tab also gains a **Stack** filter, letting you narrow resources to those deployed by specific CloudFormation stacks in your account.

![CFN Stack filter](docs/images/user-guide-cfn-stack-filter.png)

The personalized data is produced by analyzers that read your CloudTrail logs and active CloudFormation stacks, then written back to the website bucket as a personalized data set. The analysis runs on a daily schedule. You can also trigger it on demand from the Settings page using the **Run usage analysis** button. The page shows progress and result counts when the run completes; refresh the dashboard afterwards to see the updated personalization.

![Run usage analysis](docs/images/user-guide-run-analysis.png)

This repository provides two CloudFormation stacks:

### Capability Insights Stack

The core solution. It deploys a website and API into your VPC, along with a Lambda function that periodically pulls capability data from the AWS Capabilities By Region S3 bucket and makes it available through the website.

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

### Sample Environment Stack (optional)

A development stack that mimics a customer environment for testing. Customers deploying the solution use their own existing VPC and subnets. This stack creates those resources so contributors can develop and test without one.

| Resource                  | Description                                       |
| ------------------------- | ------------------------------------------------- |
| VPC                       | VPC with DNS resolution and DNS hostnames enabled |
| Subnet (with internet)    | Subnet with an Internet Gateway for user access   |
| Subnet (without internet) | Isolated subnet for backend compute               |
| S3 Gateway Endpoint       | Allows instances to access S3 from within the VPC |
| S3 Bucket                 | Deployment assets bucket for Lambda code          |
| EC2 Instance (Linux)      | Amazon Linux 2023 instance for testing            |
| IAM Role                  | Instance role with SSM and S3 access              |

### Usage Analysis Stack (opt-in)

Adds personalization. Deployed when you pass `--enable-usage-analysis` to `npm run deploy`. Reads CloudTrail logs (via Athena) and active CloudFormation stacks to build a per-account view of services, APIs, and CloudFormation resources that are actually in use, then writes a personalized data set back to the website bucket. The dashboard's "My Stuff" toggle reads that data set.

| Resource                       | Description                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Step Functions State Machine   | Orchestrates the analyzers in parallel and runs the decorator                              |
| CloudTrail Analyzer Lambda     | Queries CloudTrail logs in Athena and emits per-service usage records                      |
| CloudFormation Analyzer Lambda | Lists active CloudFormation stacks and emits per-resource records                          |
| Usage Decorator Lambda         | Joins analyzer output with the master capability catalog and writes the personalized files |
| Glue Database / Table          | Schema over the CloudTrail bucket so the analyzer can run Athena queries                   |
| Lake Formation Permissions     | Grants the analyzer role read access to the Glue database                                  |
| EventBridge Rule               | Schedules the state machine to run daily (configurable via `AnalysisSchedule` parameter)   |

### Package Structure

This project uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) to manage four packages under `source/`.

```
├── deployment/              # Deployment and dev scripts
│   ├── deploy.sh            # Deploy/teardown the Capability Insights stack
│   ├── dev.sh               # Deploy/teardown the CapabilityInsightsSampleEnvironment stack
│   └── check-deps.sh        # Validates required CLI tools (aws, node, npx)
├── docs/                    # Documentation assets
├── source/
│   ├── shared/              # Shared TypeScript types
│   ├── lambda/              # Lambda function code
│   ├── constructs/          # CDK infrastructure (synthesizes to CloudFormation)
│   └── website/             # React frontend
└── package.json             # Root workspace configuration
```

#### `source/constructs`

CDK application that defines the two CloudFormation stacks. We use CDK as a development tool to produce a standard CloudFormation template that can be deployed with the AWS CLI in any environment. No CDK installation required for deployment. On build, it synthesizes the Capability Insights stack and writes the template to `deployment/dist/template/`.

#### `source/lambda`

- **API Lambda** (`api-lambda-main.ts`): Backs the API Gateway and routes requests from the website.
- **DataFetch Lambda** (`data-fetch-lambda-main.ts`): Reads capability data from the source S3 access point, merges data across multiple source folders, and writes the results to the website bucket in both JSON and CSV formats.
- **CloudTrail Analyzer** (`cloudtrail-analyzer.ts`), **CloudFormation Analyzer** (`cloudformation-analyzer.ts`), **Usage Decorator** (`usage-decorator.ts`): Power the opt-in Usage Analysis stack. Triggered by a Step Functions state machine that runs the two analyzers in parallel, then the decorator merges their output with the master catalog into personalized files for the dashboard's "My Stuff" view.

#### `source/website`

A React dashboard built with [Cloudscape Design System](https://cloudscape.design/) to visualize the capability data.

## Development

This repository contains two CloudFormation stacks. The Capability Insights stack is what users deploy into their existing infrastructure. The Sample Environment stack creates a VPC, subnets, EC2 instance, and deployment bucket that mimic a customer environment. Use it for local development and testing when you don't have an existing environment to deploy into.

Since the dashboard is only accessible from within the VPC, the sample stack includes an EC2 instance that you can SSH into and use as a proxy to reach the dashboard from your machine. See [Accessing the Website from Your Machine](#accessing-the-website-from-your-machine) for a step-by-step guide.

To get started, generate an SSH key pair and import it into EC2:

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

# Or, to also deploy the opt-in Usage Analysis stack for personalization:
npm run dev:deploy -- --enable-usage-analysis
```

`--enable-usage-analysis` auto-discovers the CloudTrail bucket from your account. Pass `--cloudtrail-bucket <name>` to override.

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

Finally, navigate to the website URL:

```
http://capability-insights-website-<ACCOUNT_ID>-<REGION>.s3-website-<REGION>.amazonaws.com
```

## License

This project is licensed under the Apache-2.0 License. See the [LICENSE](LICENSE) file.
