# AWS Pulumi Example

This is a basic example of setting up Pulumi with AWS and Cloudflare with support for:
- shared resources
- per service resources
- environments (represented by AWS accounts)

## Structure

The repo is split into:
- aws
- shared
- api (as an example) service

Each of the sub-directories is a Pulumi Project.

### AWS

AWS is for high level AWS account configuration. It assumes that you have a manually created root AWS account, which we use to provision sub-accounts for each environment. This pulumi module exports an accounts map that can be used to assume the account role to provision resources in that account. The key for the map is the short name of the environment (e.g. `dev` or `staging`.

The AWS project only has a single stack (`prod`).

### Shared

This is for resources that might be shared between services within a single environment, for example a VPC.

### Services (e.g. API)

Each service is defined in its own project and provisions all the infrastructure it needs to run.

## Environments

Environments are supported through Pulumi stacks. Each project uses the active stack to find the associated AWS account to use, and assumes the role of the child account when provisioning resources.
