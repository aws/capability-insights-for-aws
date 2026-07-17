# capabilities-detector

Deterministically detect the **AWS services, CloudFormation resource types, and
SDK API operations** a codebase depends on — by statically reading the code.

**Fully static and offline:** no AWS credentials, no network calls, no deployed
infrastructure. It reads files and writes a report of what the code uses.

It is a single Python file plus one bundled data file. Nothing to install.

---

## Setup (one folder, two files, zero installs)

```
capabilities-detector/
├── detect.py
└── aws-api-universe.json.gz     # must sit next to detect.py
```

**Requirements: Python 3.8+ and nothing else** — no `pip install`, no
credentials, no network.

```bash
python3 detect.py /path/to/thing-to-scan
```

---

## Usage

Same command each time; only the target changes.

**Scan a code repo** (application code + CloudFormation/SAM/CDK/Terraform):
```bash
python3 detect.py /path/to/a/repo
```

**Scan CloudTrail logs** (what actually ran — a `.json`, `.json.gz`, or a
directory of them). `-` means "no repo, logs only":
```bash
python3 detect.py - --cloudtrail /path/to/cloudtrail-log.json
```

**Scan both at once** (code + runtime, one report):
```bash
python3 detect.py /path/to/a/repo --cloudtrail /path/to/cloudtrail-log.json
```

### Common flags
```bash
python3 detect.py /repo --customer "Acme" --application "svc"  # tag the results
python3 detect.py /repo --quiet                # hide the table
python3 detect.py /repo --no-report            # don't write report files
python3 detect.py /repo --no-payload           # skip the shareable results payload
python3 detect.py /repo --out-dir /tmp/run     # write outputs here
```

---

## What it detects

Three axes, each detection carrying its canonical service (`SdkServiceId` plus
the CloudTrail-style `serviceEndpointPrefix`), its evidence (`file:line`), and
how it was found (`detectionMethod`):

| Axis | What | Detected from |
|---|---|---|
| **service** | AWS services in use (S3, DynamoDB, Lambda…) | SDK dep manifests, CDK imports, boto3/Java/Go SDK, IaC resources |
| **cfn** | CloudFormation resource types (`AWS::Lambda::Function`) | CFN/SAM templates, CDK-synth output, CDK constructs, Terraform |
| **api** | SDK API operations (`S3+PutObject`) | SDK call sites (TS/Py/Java/Go) + **IAM policy actions** |

### Detection sources
- **CloudFormation / SAM templates** (YAML + JSON) — `AWS::Service::Resource` types, format-agnostic.
- **CDK synthesized templates** (`cdk.out/*.template.json`) — highest fidelity; treated as ground truth.
- **CDK construct imports** (`aws-cdk-lib/aws-<svc>`) — service + primary CFN type.
- **Terraform** (`aws_*` resource/data blocks).
- **SDK dependency manifests** — `package.json` (`@aws-sdk/client-*`), `requirements.txt`/`pyproject`, `pom.xml`/`build.gradle`, `go.mod`.
- **SDK call sites** — TS v3 Command classes, boto3, Java `model.*Request`, Go SDK methods.
- **IAM policy actions** — `"Action": ["dynamodb:Query", "s3:GetObject"]` → API operations (a precise statement of intended usage).

### Config / runtime property depth

Beyond *which* resources exist, it extracts *how they're configured* — shown in
the report's **Config** column and the JSON `attributes` field:

| Resource | Properties extracted |
|---|---|
| Lambda | runtime, memory, timeout, architecture |
| EC2 instance | instanceType, ami |
| RDS (instance/cluster) | engine, engineVersion, instanceClass, allocatedStorage |
| ElastiCache | engine, engineVersion, nodeType |
| EMR | releaseLabel |
| EKS / OpenSearch | version / engineVersion |
| DynamoDB / ECS / Glue | billingMode / cpu, memory / glueVersion, workerType |

**How a value is resolved (deterministic):**
1. **Literal** (`instance_type = "m5.large"`, `Runtime: java17`) → extracted directly.
2. **Same-scope default** — a Terraform `variable`/`locals` default or a CFN `Parameters` `Default:` → resolved.
3. **Repo-wide constant** — a value in a `*.tfvars` file → resolved (all observed values reported).
4. **Anything else** — expression, cross-module value, deploy-time input, or a wrapper construct whose value lives in another file → reported as `<unresolved>`. The detector **never** invents a value the repo doesn't contain.

> **Higher fidelity:** run your IaC's own resolver first and scan its output.
> - **CDK:** `cdk synth` → scan `cdk.out/*.template.json` (fully-resolved literals, including through wrapper constructs).
> - **Terraform:** `terraform plan -out=plan.tfplan && terraform show -json plan.tfplan > plan.json` → scan the resolved plan.

### Grounding (accuracy)

Every service and API operation is validated against the bundled
`aws-api-universe.json.gz` (the authoritative set of AWS services/operations,
generated from `botocore`). This canonicalizes names (`events` → `EventBridge`)
and drops false positives (e.g. a pandas `.read_csv()` misread as `S3+ReadCsv`,
or an IAM wildcard `s3:*`). If the data file is absent, detection still runs but
grounding is skipped — keep it next to `detect.py`.

Detection is **deterministic**: identical inputs → byte-identical output.

---

## Output

Written into the current directory by default (override with `--out-dir DIR`):

```
capabilities-report-<runid>.html    # styled, self-contained, open in a browser
capabilities-report-<runid>.md      # shareable Markdown
capabilities-report-<runid>.json    # machine-readable detections
capabilities-payload-<runid>.json   # structured results to share with AWS
```

`<runid>` is a UTC timestamp + short random suffix, so every run is distinct.

### Sharing results with AWS

The tool is fully offline — it does **not** upload anything. After a scan it
writes `capabilities-payload-<runid>.json` (the detected capability inventory,
tagged with the customer/application you provide) and prints a short notice
asking you to send that one file to your AWS point of contact for ingestion.

The payload contains **only** the detected AWS capability inventory — **no
source code, no file contents.** Use `--no-payload` to skip writing it.

---

## Files

| File | Purpose |
|---|---|
| `detect.py` | The whole tool. |
| `aws-api-universe.json.gz` | Bundled AWS service/operation universe for grounding. **Keep next to `detect.py`.** |

---

## Notes / limitations

- **Feature-level detection** (e.g. "Lambda SnapStart") is out of scope — that
  needs semantic reasoning about configuration.
- **CDK source** without `cdk synth` gives service-level + primary-CFN-type
  signal; run `cdk synth` first for full CFN fidelity and property depth.
- The detector reads code statically — it reports what the code *can* use, not a
  runtime trace of what it *did* use (that's the CloudTrail input mode).
