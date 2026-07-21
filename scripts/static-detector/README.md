# capabilities-detector

Scans a codebase and tells you which AWS it uses: the services, the
CloudFormation resource types, and the API operations. It reads the code
statically, so there's no guessing and no runtime needed.

Static and offline. No AWS credentials, no network calls, nothing deployed. It
reads files and writes a report. One Python file plus one data file, nothing to
install.

## Setup

Two files in a folder, that's the whole install:

```
capabilities-detector/
├── detect.py
└── aws-api-universe.json.gz     # keep this next to detect.py
```

Needs Python 3.8+ and nothing else. No `pip install`, no credentials, no network.

```bash
python3 detect.py /path/to/thing-to-scan
```

## Usage

Same command every time, you just change the target.

Scan a code repo (app code + CloudFormation/SAM/CDK/Terraform):
```bash
python3 detect.py /path/to/a/repo
```

Scan CloudTrail logs (what actually ran). `-` means logs only, no repo:
```bash
python3 detect.py - --cloudtrail /path/to/cloudtrail-log.json
```

Scan both at once (code + runtime in one report):
```bash
python3 detect.py /path/to/a/repo --cloudtrail /path/to/cloudtrail-log.json
```

### Flags

```bash
python3 detect.py /repo --customer "Acme" --application "svc"  # tag the results
python3 detect.py /repo --quiet          # hide the table
python3 detect.py /repo --no-report      # don't write report files
python3 detect.py /repo --no-payload     # skip the shareable results payload
python3 detect.py /repo --out-dir /tmp/run
```

## What it detects

Three axes. Each detection carries its canonical service (`SdkServiceId` and the
CloudTrail-style `serviceEndpointPrefix`), where it came from (`file:line`), and
how it was found (`detectionMethod`).

| Axis | What | Where it comes from |
|---|---|---|
| service | Services in use (S3, DynamoDB, Lambda) | SDK manifests, CDK imports, SDK calls, IaC |
| cfn | CloudFormation resource types (`AWS::Lambda::Function`) | CFN/SAM, CDK synth, CDK constructs, Terraform |
| api | API operations (`S3+PutObject`) | SDK call sites (TS/Py/Java/Go) + IAM policy actions |

### Sources it reads

- CloudFormation / SAM templates (YAML and JSON). Format-agnostic.
- CDK synth output (`cdk.out/*.template.json`, including `cdk.out.*` variants and under `build/`). Highest fidelity, everything is resolved to literals.
- CDK construct source. L1 (`new ec2.CfnInstance(...)`) resolves to the exact CFN type; L2 imports (`aws-cdk-lib/aws-<svc>`) give the service and its primary type. It pulls config out of both, so you don't have to synth first.
- Terraform (`aws_*` resource and data blocks).
- SDK dependency manifests: `package.json`, `requirements.txt`/`pyproject`, `pom.xml`/`build.gradle`, `go.mod`.
- SDK call sites: TS v3 Command classes, boto3, Java `model.*Request`, Go SDK methods.
- IAM policy actions: `"Action": ["dynamodb:Query", "s3:GetObject"]` becomes API operations. That's a statement of intent, not proof the call runs.

### Config it pulls out

It doesn't just tell you a resource exists, it tells you how it's configured.
Shows up in the report's Config column and the JSON `attributes` field.

| Resource | Properties |
|---|---|
| Lambda | runtime, memory, timeout, architecture |
| EC2 instance | instanceType, ami |
| RDS (instance/cluster) | engine, engineVersion, instanceClass, allocatedStorage |
| ElastiCache | engine, engineVersion, nodeType |
| EMR | releaseLabel |
| EKS / OpenSearch | version / engineVersion |
| DynamoDB / ECS / Glue | billingMode / cpu, memory / glueVersion, workerType |

Works from CloudFormation/SAM, Terraform, and CDK source (L1 and L2 constructs).

How it figures out a value, in order:

1. Literal (`instance_type = "m5.large"`, `Runtime: java17`, `runtime: 'nodejs20.x'`). Taken as-is.
2. Reference to a same-scope default (a Terraform `variable`/`locals` default, or a CFN `Parameters` `Default:`). Resolved.
3. Reference to a repo-wide constant in a `*.tfvars` file. Resolved, and if the repo declares more than one value it reports all of them.
4. A CDK enum or builder expression (`ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO)`, `Runtime.JAVA_17`). Kept verbatim so the tokens survive (`T3` + `MICRO`), and something downstream turns that into `t3.micro`. The tool deliberately doesn't map enums to strings itself, so it never goes stale when AWS ships new types.
5. Anything else (a cross-file variable, a deploy-time input). Reported as `<unresolved>`. It never makes up a value the repo doesn't contain.

Want the cleanest values? Run your IaC's own resolver first and point the tool at
the output. It reads that automatically and unions it with what it found in
source, so you get both the resolved literal and the source form.

- CDK: `cdk synth`, then scan as usual (it finds `cdk.out/`, including `build/cdk.out`). Every property comes out resolved (`t3.micro` instead of the enum). A repo can have more than one CDK app, so synth each one to catch all the stacks.
- Terraform: `terraform plan -out=plan.tfplan && terraform show -json plan.tfplan > plan.json`, then scan the plan JSON.

### Grounding

Every service and API operation is checked against the bundled
`aws-api-universe.json.gz` (the real set of AWS services and operations,
generated from `botocore`). That canonicalizes names (`events` becomes
`EventBridge`) and drops false positives, like a pandas `.read_csv()` misread as
`S3+ReadCsv` or an IAM wildcard `s3:*`. If the data file isn't there, detection
still runs but skips grounding, so keep it next to `detect.py`.

Detection is deterministic: same input, byte-identical output.

## Output

Goes to the current directory unless you pass `--out-dir`:

```
capabilities-report-<runid>.html    # styled, self-contained, open in a browser
capabilities-report-<runid>.md      # markdown
capabilities-report-<runid>.json    # machine-readable detections
capabilities-payload-<runid>.json   # structured results to share
```

`<runid>` is a UTC timestamp plus a short random suffix, so runs don't collide.

### Sharing results

The tool doesn't upload anything. After a scan it writes
`capabilities-payload-<runid>.json` (the detected inventory, tagged with the
customer/application you gave it) and prints a note telling you to send that one
file to your AWS contact. Review it before you send it. It contains only the
detected capability inventory, no source code and no file contents. Skip it with
`--no-payload`.

## Files

| File | Purpose |
|---|---|
| `detect.py` | The whole tool. |
| `aws-api-universe.json.gz` | AWS service/operation data for grounding. Keep it next to `detect.py`. |

## Notes and limits

- Feature-level detection (like "Lambda SnapStart") is out of scope. That needs semantic reasoning about config.
- CDK source works without `cdk synth`: L1 constructs resolve to exact CFN types and config gets pulled out, with enum/builder expressions kept verbatim. Synth is optional and just gives you cleaner resolved values (`t3.micro` instead of the enum). When both source and synth are present, the tool unions them.
- It reads code statically, so it reports what the code can use, not a trace of what actually ran. For that, feed it CloudTrail logs.
