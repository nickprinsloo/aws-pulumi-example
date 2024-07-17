import * as aws from "@pulumi/aws";
import type { Cluster as EcsCluster } from "@pulumi/aws/ecs";
import type { Listener, LoadBalancer } from "@pulumi/aws/lb";
import * as awsx from "@pulumi/awsx";
import type { Vpc } from "@pulumi/awsx/ec2";
import * as cf from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const project = pulumi.getProject();
const stack = pulumi.getStack();
const config = new pulumi.Config("api");

const awsMainStack = new pulumi.StackReference("example/aws/prod");
const shared = new pulumi.StackReference(`example/shared/${stack}`);

const vpc: pulumi.OutputInstance<Vpc> = shared.getOutput("vpc");
const ecsCluster: pulumi.OutputInstance<EcsCluster> =
  shared.getOutput("ecsCluster");
const cloudflareZone: pulumi.OutputInstance<cf.Zone> =
  shared.getOutput("cloudflareZone");
const loadBalancer: pulumi.OutputInstance<LoadBalancer> =
  shared.getOutput("loadBalancer");
const listener: pulumi.OutputInstance<Listener> = shared.getOutput("listener");

// Create a provider that assumes the role of the child account
export const provider = new aws.Provider("scoped-provider", {
  region: "eu-west-2",
  allowedAccountIds: [
    awsMainStack
      .requireOutput("accounts")
      .apply((accounts) => accounts[stack].id),
  ],
  assumeRole: {
    roleArn: awsMainStack
      .requireOutput("accounts")
      .apply((accounts) => accounts[stack].arn),
  },
});

/**
 * Configure secrets and environment variables
 * These will be added to the ECS service as environment variables
 */
const domain = config.require("domain");

const secrets = [
  {
    name: "EXAMPLE_SECRET",
    value: config.requireSecret("EXAMPLE_SECRET"),
  },
];

const envs = [
  {
    name: "NODE_ENV",
    value: "production",
  },
];

function createSecret({
  name,
  value,
}: {
  name: string;
  value: string | pulumi.Output<string>;
}) {
  const secret = new aws.ssm.Parameter(
    `${project}-${name.toLocaleLowerCase()}-${stack}`,
    {
      type: "SecureString",
      value,
    },
    { provider }
  );

  return { name, valueFrom: secret.arn };
}

const args = Object.fromEntries(envs.map((env) => [env.name, env.value]));
const secretAsArns = secrets.map(createSecret);

/**
 * Application deployment
 */

/**
 * Create the target group for the load balancer
 */
const targetGroup = new aws.lb.TargetGroup(
  `${project}-tg-${stack}`,
  {
    vpcId: vpc.apply((vpc) => vpc.vpcId),
    targetType: "ip",
    port: 3000,
    protocol: "HTTP",
    healthCheck: {
      path: "/healthcheck",
    },
  },
  { provider }
);

/**
 * Associate the target group with the listener
 * The conditions is what needs to be met for this rule to be applied
 * In this case it is any request that matches the configured domain
 * This lets us reuse the same ALB for multiple services
 */
const listenerRule = new aws.lb.ListenerRule(
  `${project}-listener-${stack}`,
  {
    listenerArn: listener.apply((l) => l.arn),
    actions: [
      {
        type: "forward",
        targetGroupArn: targetGroup.arn,
      },
    ],
    conditions: [
      {
        hostHeader: {
          values: [domain],
        },
      },
    ],
  },
  { provider }
);

/**
 * Create an ECR repository for the service
 */
const repository = new awsx.ecr.Repository(
  `${project}-repository-${stack}`,
  {
    forceDelete: true,
  },
  { provider }
);

/**
 * This is currently setup to create the image
 * from the Dockerfile in the root of the project
 * This can be skipped and the ECR build, push and deploy can be done in Github Actions
 */
export const image = new awsx.ecr.Image(
  `${project}-image-${stack}`,
  {
    repositoryUrl: repository.url,
    dockerfile: "Dockerfile.api",
    context: ".",
    platform: "linux/amd64",
    args,
  },
  { provider }
);

/**
 * Create the execution role for the ECS service
 */
const executionRole = new aws.iam.Role(
  `${project}-task-execution-role-${stack}`,
  {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ecs-tasks.amazonaws.com",
    }),
  },
  { provider }
);

/**
 * Attach the SSM policy to the execution role
 * This is required for the ECS service to read from SSM
 */
const ssmPolicyAttachment = new aws.iam.RolePolicyAttachment(
  `${project}-ssm-role-policy-attachment-${stack}`,
  {
    role: executionRole,
    policyArn: aws.iam.ManagedPolicy.AmazonSSMReadOnlyAccess,
  },
  { provider }
);

/**
 * Attach the ECS task execution policy to the execution role
 * This is required for the ECS service to run
 */
const taskExecutionPolicyAttachment = new aws.iam.RolePolicyAttachment(
  `${project}-ecs-role-policy-attachment-${stack}`,
  {
    role: executionRole,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
  },
  { provider }
);

/**
 * Create the security group for the ECS service
 * Allows all traffic via the ALB (if the listener rule matches)
 */
const securityGroup = new aws.ec2.SecurityGroup(
  `${project}-sg-${stack}`,
  {
    vpcId: vpc.apply((vpc) => vpc.vpcId),
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
 * The ECS service runs in the private subnets
 * It is not exposed directly to the internet but via the ALB
 */
const appService = new awsx.ecs.FargateService(
  `${project}-service-${stack}`,
  {
    cluster: ecsCluster.apply((cluster) => cluster.arn),
    networkConfiguration: {
      subnets: vpc.apply((vpc) => vpc.privateSubnetIds),
      securityGroups: [securityGroup.id],
    },
    desiredCount: 1,
    taskDefinitionArgs: {
      executionRole: {
        roleArn: executionRole.arn,
      },
      runtimePlatform: {
        cpuArchitecture: "X86_64",
      },
      container: {
        healthCheck: {
          command: [
            "CMD-SHELL",
            "curl -f http://localhost:3000/healthcheck || exit 1",
          ],
        },
        environment: envs,
        secrets: secretAsArns,
        name: `${project}-${stack}-api`,
        image: image.imageUri,
        cpu: 128,
        memory: 512,
        essential: true,
        portMappings: [
          {
            hostPort: 3000,
            containerPort: 3000,
            targetGroup: targetGroup,
          },
        ],
      },
    },
  },
  { provider }
);

/**
 * Create a DNS record for the service
 * This is required for the service to be accessible via the domain
 * You can use Route 53 here instead
 */
const appDomainRecord = new cf.Record(`${project}-${stack}-api-domain-record`, {
  name: "api",
  zoneId: cloudflareZone.apply((zone) => zone.id),
  type: "CNAME",
  value: loadBalancer.apply((lb) => lb.dnsName),
  ttl: 1,
  proxied: true,
});
