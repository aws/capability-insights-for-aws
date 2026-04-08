import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface CapabilityInsightsSampleEnvironmentProps extends cdk.StackProps {
  ec2KeyPair?: string;
}

export enum CapabilityInsightsSampleEnvironmentOutputs {
  PrivateVpcId = 'PrivateVpcId',
  BackendSubnetId = 'BackendSubnetId',
  ApiAccessSubnetId = 'ApiAccessSubnetId',
  DeploymentAssetsBucketName = 'DeploymentAssetsBucketName',
}

/**
 * Sample environment stack for development and testing.
 */
export class CapabilityInsightsSampleEnvironmentStack extends cdk.Stack {
  public readonly vpc: ec2.CfnVPC;
  public readonly privateSubnet: ec2.CfnSubnet;
  public readonly publicSubnet: ec2.CfnSubnet;
  public readonly deploymentAssetsBucket: s3.CfnBucket;

  constructor(app: cdk.App, id: string, props?: CapabilityInsightsSampleEnvironmentProps) {
    super(app, id, props);

    const az = cdk.Fn.select(0, cdk.Fn.getAzs());

    const prefix = 'CapabilityInsightsSampleEnvironment';
    const vpcName = `${prefix}Vpc`;
    this.vpc = new ec2.CfnVPC(this, vpcName, {
      cidrBlock: '10.0.0.0/16',
      // enableDnsSupport & enableDnsHostnames are needed to enable VPC Endpoint to API Gateway
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: vpcName }],
    });
    const privateSubnetName = `${vpcName}PrivateSubnet`;
    this.privateSubnet = new ec2.CfnSubnet(this, privateSubnetName, {
      availabilityZone: az,
      cidrBlock: '10.0.0.0/24',
      mapPublicIpOnLaunch: false,
      vpcId: this.vpc.attrVpcId,
      tags: [{ key: 'Name', value: privateSubnetName }],
    });

    // What makes a subnet "public" is the presence of an Internet Gateway
    const internetGatewayName = `${vpcName}IGW`;
    const internetGateway = new ec2.CfnInternetGateway(this, internetGatewayName, {
      tags: [{ key: 'Name', value: internetGatewayName }],
    });
    new ec2.CfnVPCGatewayAttachment(this, `${internetGatewayName}VPCAttachment`, {
      vpcId: this.vpc.attrVpcId,
      internetGatewayId: internetGateway.attrInternetGatewayId,
    });
    const publicRouteTableName = `${vpcName}PublicRouteTable`;
    const publicRouteTable = new ec2.CfnRouteTable(this, publicRouteTableName, {
      vpcId: this.vpc.attrVpcId,
      tags: [{ key: 'Name', value: publicRouteTableName }],
    });
    const publicRouteName = `${vpcName}IGWRoute`;
    new ec2.CfnRoute(this, publicRouteName, {
      routeTableId: publicRouteTable.attrRouteTableId,
      gatewayId: internetGateway.attrInternetGatewayId,
      destinationCidrBlock: '0.0.0.0/0', // By default routes traffic to internet
    });
    const publicSubnetName = `${vpcName}PublicSubnet`;
    this.publicSubnet = new ec2.CfnSubnet(this, publicSubnetName, {
      availabilityZone: az,
      cidrBlock: '10.0.1.0/24',
      mapPublicIpOnLaunch: true,
      vpcId: this.vpc.attrVpcId,
      tags: [{ key: 'Name', value: publicSubnetName }],
    });
    new ec2.CfnSubnetRouteTableAssociation(this, `${publicSubnetName}RouteTableAssociation`, {
      subnetId: this.publicSubnet.attrSubnetId,
      routeTableId: publicRouteTable.attrRouteTableId,
    });

    // VPC Gateway Endpoint to S3 - so instances can call S3
    const vpcS3EndpointName = `${vpcName}S3Endpoint`;
    new ec2.CfnVPCEndpoint(this, vpcS3EndpointName, {
      vpcId: this.vpc.attrVpcId,
      vpcEndpointType: 'Gateway',
      serviceName: cdk.Fn.sub('com.amazonaws.${AWS::Region}.s3'),
      routeTableIds: [publicRouteTable.attrRouteTableId],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: cdk.Fn.sub(
              'arn:${AWS::Partition}:s3:::capability-insights-website-${AWS::AccountId}-${AWS::Region}/*',
            ),
          },
        ],
      },
      tags: [{ key: 'Name', value: vpcS3EndpointName }],
    });

    const keypairName = props?.ec2KeyPair;

    // IAM role that the instances in VPC will use
    const instanceRoleName = `CapabilityInsightsSampleEnvInstanceRole`;
    const instanceRoleNameFn = cdk.Fn.sub(`${instanceRoleName}-\${AWS::Region}`);
    const instanceRole = new iam.CfnRole(this, instanceRoleName, {
      roleName: instanceRoleNameFn,
      description: 'IAM role for instances in the sample environment VPC.',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'ec2.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [cdk.Fn.sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')],
    });

    // Create Linux instance
    const sshSecurityGroupName = `${vpcName}SSHSG`;
    const sshSecurityGroup = new ec2.CfnSecurityGroup(this, sshSecurityGroupName, {
      groupName: sshSecurityGroupName,
      groupDescription: `Security Group for the ${vpcName} vpc that allows incoming SSH connections.`,
      vpcId: this.vpc.attrVpcId,
      securityGroupEgress: [
        {
          ipProtocol: '-1', // all protocols
          cidrIp: '0.0.0.0/0', // allow all traffic
          description: 'Allow all outbound traffic',
        },
      ],
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          cidrIp: '0.0.0.0/0',
          fromPort: 22, // ssh
          toPort: 22,
          description: 'Allow incoming SSH from anywhere',
        },
      ],
    });
    const latestLinuxAmiId = new cdk.CfnParameter(this, 'LatestAmazonLinux2023AmiId', {
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      description: 'Latest Amazon Linux 2023 AMI ID from SSM Parameter Store',
    });
    const linuxInstanceName = `${publicSubnetName}LinuxInstance`;
    const linuxInstanceProfileName = `${linuxInstanceName}Profile`;
    const linuxInstanceProfile = new iam.CfnInstanceProfile(this, linuxInstanceProfileName, {
      instanceProfileName: linuxInstanceProfileName,
      roles: [instanceRoleNameFn],
    });
    linuxInstanceProfile.addDependency(instanceRole);
    const linuxInstance = new ec2.CfnInstance(this, linuxInstanceName, {
      subnetId: this.publicSubnet.attrSubnetId,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO).toString(),
      imageId: latestLinuxAmiId.valueAsString,
      iamInstanceProfile: linuxInstanceProfileName,
      securityGroupIds: [sshSecurityGroup.attrGroupId],
      keyName: keypairName || undefined,
      tags: [{ key: 'Name', value: linuxInstanceName }],
    });
    linuxInstance.addDependency(linuxInstanceProfile);

    // Assets bucket name: "capability-insights-assets-{account}-{region}"
    // Also referenced in: deployment/deploy.sh (passed via DeploymentAssetsBucketName parameter)
    const deploymentAssetsBucketResourceName = `capability-insights-assets`;
    const deploymentAssetsBucketNameFn = cdk.Fn.sub('capability-insights-assets-${AWS::AccountId}-${AWS::Region}');
    this.deploymentAssetsBucket = new s3.CfnBucket(this, deploymentAssetsBucketResourceName, {
      bucketName: deploymentAssetsBucketNameFn,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          {
            serverSideEncryptionByDefault: {
              sseAlgorithm: 'AES256',
            },
          },
        ],
      },
    });

    new cdk.CfnOutput(this, CapabilityInsightsSampleEnvironmentOutputs.PrivateVpcId, {
      value: this.vpc.attrVpcId,
    });
    new cdk.CfnOutput(this, CapabilityInsightsSampleEnvironmentOutputs.BackendSubnetId, {
      value: this.privateSubnet.attrSubnetId,
    });
    new cdk.CfnOutput(this, CapabilityInsightsSampleEnvironmentOutputs.ApiAccessSubnetId, {
      value: this.publicSubnet.attrSubnetId,
    });
    new cdk.CfnOutput(this, CapabilityInsightsSampleEnvironmentOutputs.DeploymentAssetsBucketName, {
      value: this.deploymentAssetsBucket.ref,
    });
  }
}
