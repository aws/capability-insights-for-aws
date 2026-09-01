# Least-privilege deployment role

These files are an **example** set of least-privilege IAM policies for a role that
can deploy Capability Insights for AWS **without Admin access**. They are a
starting point — review and scope them to your account before using them.

Because the three add-on stacks are opt-in, the policy is **split** so you attach
only what you actually deploy:

| File                                         | When to attach                  | Grants                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment-iam-policy-base.json`            | **Always** (required)           | CloudFormation (base stack) + template summary, IAM roles + PassRole (lambda/apigateway), Lambda, S3 (website + assets buckets), EC2 networking, API Gateway, EventBridge, CloudWatch Logs, `sts:GetCallerIdentity` |
| `deployment-iam-policy-usage-analysis.json`  | with `--enable-usage-analysis`  | CloudFormation (usage stack), Step Functions (+`StartExecution`), Glue, Lake Formation grants, Athena (runtime), PassRole (states/events), `cloudtrail:DescribeTrails`                                              |
| `deployment-iam-policy-policy-enforcer.json` | with `--enable-policy-enforcer` | CloudFormation (policy-enforcer stack), DynamoDB                                                                                                                                                                    |
| `deployment-iam-policy-chat.json`            | with `--enable-chat`            | CloudFormation (chat stack), `bedrock:InvokeModel` (deploy-time preflight)                                                                                                                                          |

The add-ons deliberately do **not** repeat the base grants: every stack's IAM
roles, Lambdas, log groups, security groups, and EventBridge rules are named
`CapabilityInsights*` and are already covered by the base policy, which is always
attached (the add-on stacks require the base stack to exist first). Each file is
well under the 6,144-char customer-managed-policy limit (base ~3,960; add-ons
< 2,200 each), so attach them as separate managed policies (a role allows up to
10), or concatenate the statements into one inline policy.

## Using it

1. Replace the placeholders in each file you attach:
   - `<ACCOUNT_ID>` — your AWS account id
   - `<REGION>` — the region you deploy into
   - `<DEPLOYMENT_ASSETS_BUCKET>` — the bucket you pass as `--deployment-assets-bucket-name` (base file)
2. Create a role your identity can assume; attach `-base` plus the add-on(s) for
   the flags you will use. `deployment-role-trust-policy.json` in this folder is an
   example trust policy — replace `<TRUSTED_PRINCIPAL_ARN>` with the identity that
   will run the deploy (e.g. `arn:aws:iam::<ACCOUNT_ID>:role/<YourAdminOrSsoRole>`
   or your CI role). Example — base + usage analysis:
   ```bash
   aws iam create-role --role-name CapInsightsDeployer \
     --assume-role-policy-document file://docs/deployment-role-trust-policy.json
   aws iam put-role-policy --role-name CapInsightsDeployer --policy-name ci-deploy-base \
     --policy-document file://docs/deployment-iam-policy-base.json
   aws iam put-role-policy --role-name CapInsightsDeployer --policy-name ci-deploy-usage \
     --policy-document file://docs/deployment-iam-policy-usage-analysis.json
   ```
3. Deploy while assuming that role, and tell the deploy which role it is so Lake
   Formation is configured correctly (see below):
   ```bash
   npm run deploy -- --deployer-role-name CapInsightsDeployer \
     --deployment-assets-bucket-name <DEPLOYMENT_ASSETS_BUCKET> \
     --source-access-point-arn <arn> \
     --enable-usage-analysis
   ```
   If you omit `--deployer-role-name`, `deploy.sh` derives it from your caller
   identity (falling back to `Admin`).

## Why `--deployer-role-name` matters (Lake Formation)

Only the **Usage Analysis** stack couples to the deploying principal. It registers
the deploy role as a Lake Formation **Data Lake Admin** (via the `DeployerRoleName`
template parameter) so its `AWS::LakeFormation::Permissions` grants can be created.
That name **must match the role CloudFormation actually runs as** — otherwise the
grants fail with `AccessDeniedException`. `deploy.sh` now passes it automatically.

Caveat: if your account **already** has Lake Formation enabled with Data Lake
Admins that exclude your deploy role, the bootstrap cannot add itself. In that
case an existing LF admin must add the deploy role (or grant it
`lakeformation:PutDataLakeSettings`) before the first deploy.

The base, Policy Enforcer, and Chat stacks have **no** deployer-principal coupling
and need nothing beyond the resource permissions in their files.

## Notes on specific grants

- `athena:*` in the usage-analysis file is scoped to the account's default
  `primary` workgroup. It is primarily a **runtime** path used by the analyzer
  Lambda's own role; it is included here for completeness and if you validate
  queries as the deploy role.
- `cloudformation:GetTemplateSummary` is in the **base** file on `Resource: "*"`
  (it does not support resource-level scoping) — `aws cloudformation deploy` calls
  it on every stack update, so it is required even for update-only runs.
- `Resource: "*"` on EC2, API Gateway, and Lake Formation reflects that those
  actions are poorly resource-scopeable. Tighten with your own conditions if your
  guardrails require it.

## Not yet validated end-to-end

These policies were synthesized from a per-stack audit of the CloudFormation
templates and cross-checked against `deploy.sh`, but have **not** yet been
verified by a full deployment under a freshly-created non-admin role (tracked as
the E2E item in ALM-2681). Expect to iterate and add anything a real run surfaces.
