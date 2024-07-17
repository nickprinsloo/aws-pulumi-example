/**
 * Creates the AWS accounts for the organisation for each environment
 * In this case only a single account is created for development but the
 * pattern is there for other environments to be created in the future
 */
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const devAccountEmailId = new random.RandomId("dev-account-email-id", {
  byteLength: 4,
});

export const devAccount = new aws.organizations.Account(
  "development-account",
  {
    name: "Development",
    email: pulumi.interpolate`superadmin+${devAccountEmailId.hex}@example.com`,
    roleName: "OrganizationalAccountAccessRole",
    closeOnDeletion: true,
  },
  { protect: true }
);

type Account = {
  id: pulumi.Output<string>;
  arn: pulumi.Output<string>;
};

export const accounts: Record<string, Account> = {
  dev: {
    id: devAccount.id,
    arn: pulumi.interpolate`arn:aws:iam::${devAccount.id}:role/OrganizationalAccountAccessRole`,
  },
};

export type Accounts = typeof accounts;
