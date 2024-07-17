/**
 * Creates the shared resources for the organisation
 * Whether something is shared is use-case specific but I've found these are reasonable defaults
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as cf from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";

import type { Accounts } from "../aws";

const project = pulumi.getProject();
const stack = pulumi.getStack();
const config = new pulumi.Config("shared");
const awsConfig = new pulumi.Config("aws");

const awsMainStack = new pulumi.StackReference("example/aws/prod");

const accounts: pulumi.OutputInstance<Accounts> =
  awsMainStack.getOutput("accounts");

// Create a provider that assumes the role of the child account
export const provider = new aws.Provider("scoped-provider", {
  region: awsConfig.require("region") as aws.Region,
  allowedAccountIds: [accounts.apply((accounts) => accounts[stack].id)],
  assumeRole: {
    roleArn: accounts.apply((accounts) => accounts[stack].arn),
  },
});

// This represents the domain we're using in Cloudflare
// If you're not using Cloudflare, you can remove the CF specific code
// e.g. example.com
export const cloudflareZone = cf.Zone.get(
  `${project}-zone-${stack}`,
  config.require("cfZoneId")
);

/**
 * SES and verification
 */

const sesDomainIdentity = new aws.ses.DomainIdentity(
  `${project}-domain-identity-${stack}`,
  {
    domain: cloudflareZone.zone,
  },
  { provider }
);

const sesDomainDkim = new aws.ses.DomainDkim(
  `${project}-domain-dkim-${stack}`,
  {
    domain: sesDomainIdentity.domain,
  },
  { provider }
);

/**
 * Setup DNS records for DKIM and SES verification
 */
const sesDomainDkimRecords = sesDomainDkim.dkimTokens.apply((tokens) =>
  tokens.map(
    (token, index) =>
      new cf.Record(`${project}-ses-dkim-${stack}-${index}`, {
        zoneId: cloudflareZone.id,
        name: pulumi.interpolate`${token}._domainkey`,
        type: "CNAME",
        value: pulumi.interpolate`${token}.dkim.amazonses.com`,
        ttl: 60,
        proxied: false,
      })
  )
);

const sesRecordVerificationRecord = new cf.Record(
  `${project}-ses-verification-${stack}`,
  {
    name: pulumi.interpolate`_amazonses.${sesDomainIdentity.domain}`,
    zoneId: cloudflareZone.id,
    type: "TXT",
    value: sesDomainIdentity.verificationToken,
    ttl: 60,
    proxied: false,
  }
);

const sesDomainVerification = new aws.ses.DomainIdentityVerification(
  `${project}-ses-domain-verification-${stack}`,
  { domain: sesDomainIdentity.domain },
  {
    dependsOn: [sesRecordVerificationRecord],
    provider,
  }
);

/**
 * TLS Certificates
 */

export const certificate = new aws.acm.Certificate(
  `${project}-certificate-${stack}`,
  {
    domainName: pulumi.interpolate`*.${cloudflareZone.zone}`,
    validationMethod: "DNS",
  },
  { provider }
);

const certificateValidation = new aws.acm.CertificateValidation(
  `${project}-certificate-validation-${stack}`,
  { certificateArn: certificate.arn },
  { provider }
);

/**
 * Setup DNS records for certificate validation
 */
const certificateValidationRecord = new cf.Record(
  `${project}-certificate-validation-${stack}`,
  {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    zoneId: cloudflareZone.id,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    value: certificate.domainValidationOptions[0].resourceRecordValue,
    ttl: 60,
    proxied: false,
  }
);

/**
 * Network
 */

/**
 * This creates a VPC with a single NAT gateway and support for DNS
 */
export const vpc = new awsx.ec2.Vpc(
  `${project}-vpc-${stack}`,
  {
    enableDnsHostnames: true,
    enableDnsSupport: true,
    natGateways: {
      strategy: awsx.ec2.NatGatewayStrategy.Single,
    },
  },
  { provider }
);

/**
 * Create a security group that allows access to the loadbalancer
 * from anywhere. This can be narrowed in the future if necessary
 */
const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup(
  `${project}-lb-sg-${stack}`,
  {
    vpcId: vpc.vpcId,
    egress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        ipv6CidrBlocks: ["::/0"],
      },
    ],
    ingress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        ipv6CidrBlocks: ["::/0"],
      },
    ],
  },
  { provider }
);

/**
 * Define an application load balancer in front of the public VPC subnets
 */
export const loadBalancer = new aws.lb.LoadBalancer(
  `${project}-lb-${stack}`,
  {
    loadBalancerType: "application",
    securityGroups: [loadBalancerSecurityGroup.id],
    subnets: vpc.publicSubnetIds,
  },
  { provider }
);

/**
 * This is the default listener for the ALB
 * It associates the certificate with the ALB and creates a default
 * 404 page for any requests that don't match a service
 */
export const listener = new aws.lb.Listener(
  `${project}-listener-${stack}`,
  {
    loadBalancerArn: loadBalancer.arn,
    port: 443,
    protocol: "HTTPS",
    certificateArn: certificate.arn,
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    defaultActions: [
      {
        type: "fixed-response",
        fixedResponse: {
          statusCode: "404",
          contentType: "text/plain",
          messageBody: "Not found",
        },
      },
    ],
  },
  { provider }
);

/**
 * ECS Cluster
 * This creates a cluster with a default configuration and Cloudwatch logging
 * If not using Cloudwatch logging, turn this off.
 */
export const ecsCluster = new aws.ecs.Cluster(
  `${project}-cluster-${stack}`,
  {
    configuration: {
      executeCommandConfiguration: {
        logging: "OVERRIDE",
        logConfiguration: {
          cloudWatchEncryptionEnabled: true,
          cloudWatchLogGroupName: `${project}-cluster-lg-${stack}`,
        },
      },
    },
  },
  { provider }
);

/**
 * Primary Application Database
 */

/**
 * Create a security group for the RDS cluster
 */
const rdsSecurityGroup = new aws.ec2.SecurityGroup(
  `${project}-rds-cluster-sg-${stack}`,
  {
    vpcId: vpc.vpc.id,
    ingress: [
      {
        protocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  },
  { provider }
);

/**
 * Create a subnet group for the RDS cluster
 * We are setting this in the public subnet to give the cluster access to the internet
 */
const rdsSubnetGroup = new aws.rds.SubnetGroup(
  `${project}-rds-cluster-subnet-group-${stack}`,
  {
    subnetIds: vpc.publicSubnetIds,
  },
  { provider }
);

const rdsInstanceMasterPassword = new RandomPassword(
  `${project}-rds-cluster-password-${stack}`,
  {
    length: 32,
    special: false,
  }
);

const availabilityZones = aws.getAvailabilityZones({
  state: "available",
});

const firstAzName = availabilityZones.then((az) => az.names.sort()[0]);

/**
 * Create the RDS cluster
 * Worth noting this is setup for a single AZ
 * Tweak as needed
 */
export const rdsCluster = new aws.rds.Cluster(
  `${project}-rds-cluster-${stack}`,
  {
    clusterIdentifierPrefix: `${project}-rds-cluster-${stack}`,
    availabilityZones: [firstAzName],
    dbSubnetGroupName: rdsSubnetGroup.name,
    vpcSecurityGroupIds: [rdsSecurityGroup.id],
    preferredMaintenanceWindow: "sun:00:00-sun:00:30",
    preferredBackupWindow: "01:00-05:00",
    backupRetentionPeriod: 35,
    iamDatabaseAuthenticationEnabled: true,
    storageEncrypted: true,
    engine: "aurora-postgresql",
    engineMode: "provisioned",
    engineVersion: "16.1",
    databaseName: "exampledb",
    masterUsername: "example",
    masterPassword: rdsInstanceMasterPassword.result,
    skipFinalSnapshot: true,
    serverlessv2ScalingConfiguration: {
      minCapacity: 0.5,
      maxCapacity: 1,
    },
    deletionProtection: stack === "prod",
  },
  { provider, ignoreChanges: ["availabilityZones"] }
);

/**
 * Create the RDS cluster instance
 */
export const rdsInstance = new aws.rds.ClusterInstance(
  `${project}-rds-cluster-instance-${stack}`,
  {
    identifierPrefix: `${project}-rds-cluster-instance-${stack}`,
    clusterIdentifier: rdsCluster.id,
    dbSubnetGroupName: rdsSubnetGroup.name,
    instanceClass: "db.serverless",
    engine: rdsCluster.engine as pulumi.Output<aws.rds.EngineType>,
    engineVersion: rdsCluster.engineVersion,
    performanceInsightsEnabled: true,
    performanceInsightsRetentionPeriod: 7,
    publiclyAccessible: true,
  },
  { provider }
);
