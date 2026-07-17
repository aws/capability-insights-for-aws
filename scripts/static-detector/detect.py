#!/usr/bin/env python3
"""
capabilities-detector — deterministically detect the AWS services, CloudFormation
resource types, and SDK API operations a codebase depends on, and write a report
of what it uses.

    python3 detect.py <path> [--csv out.csv] [--json out.json]

NO AWS credentials, NO GitHub token, NO network, NO deployed infrastructure
required. Detection is a pure static read of the code.

Deterministic by construction: identical inputs -> byte-identical output. No LLM,
no network for the detection phase. Python 3 standard library ONLY.

Detection sources (in rough fidelity order):
  * CloudFormation / SAM templates (YAML/JSON) — AWS::Service::Resource types
  * CDK synthesized templates (cdk.out/*.template.json) — same, high fidelity
  * Terraform (.tf) — aws_* resource + data blocks
  * SDK dependency manifests — package.json, requirements.txt, pyproject.toml,
      go.mod, pom.xml, build.gradle — service-level dependency signal
  * SDK call sites — TS/JS (v3 Command + v2 client.method), Python (boto3),
      Java (v2 client calls), Go — API-operation signal

Every detection carries provenance: file:line and detectionMethod.
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

# --------------------------------------------------------------------------- #
# Workspace walk configuration: directories that never contain first-party
# source worth scanning (dependencies, build output, tool caches, IDE state).
# --------------------------------------------------------------------------- #
SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "target", ".terraform",
    "__pycache__", ".venv", "venv", "vendor", ".next", ".nuxt", "coverage",
    ".nyc_output", "bin", "obj", "env", ".bemol", "logs", ".brazil",
    ".idea", ".vscode",
}

# cdk.out is NOT skipped — synthesized templates there are our highest-fidelity
# CFN source. It is walked explicitly (see collect_files).
SYNTH_DIR = "cdk.out"

# The detector's own source and bundled data. When a user scans the folder the
# detector lives in (e.g. a demo run from inside the repo), its example strings
# (`boto3.client("dynamodb")` in parser patterns) would be misread as real
# detections. Exclude our own files so a self-scan reports nothing spurious.
_SELF_FILES = frozenset(
    os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), n))
    for n in ("detect.py", "aws-api-universe.json.gz"))

MANIFEST_NAMES = {
    "package.json", "requirements.txt", "pyproject.toml", "setup.py",
    "setup.cfg", "Pipfile", "go.mod", "pom.xml", "build.gradle",
    "build.gradle.kts",
}

CFN_SAM_NAMES = {
    "template.yaml", "template.yml", "template.json",
    "serverless.yml", "serverless.yaml",
}

SOURCE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".java", ".go",
}

# CDK construct-library segment -> (display name, primary CFN resource type).
# Keyed by the short service segment that appears in BOTH `aws-cdk-lib/aws-<seg>`
# and internal construct wrappers `<scope>/…-<seg>`. The CFN type is the
# construct's PRIMARY resource — emitted at MEDIUM confidence (the exact set of
# types comes from a `cdk synth`; this is the best-effort when no synth is
# present). Curated: a construct segment maps to a service + primary CFN type.
CDK_SERVICE = {
    "s3": ("Amazon S3", "AWS::S3::Bucket"),
    "lambda": ("AWS Lambda", "AWS::Lambda::Function"),
    "dynamodb": ("Amazon DynamoDB", "AWS::DynamoDB::Table"),
    "sns": ("Amazon SNS", "AWS::SNS::Topic"),
    "sqs": ("Amazon SQS", "AWS::SQS::Queue"),
    "kms": ("AWS KMS", "AWS::KMS::Key"),
    "secretsmanager": ("AWS Secrets Manager", "AWS::SecretsManager::Secret"),
    "events": ("Amazon EventBridge", "AWS::Events::Rule"),
    "logs": ("Amazon CloudWatch Logs", "AWS::Logs::LogGroup"),
    "cloudwatch": ("Amazon CloudWatch", "AWS::CloudWatch::Alarm"),
    "ec2": ("Amazon Virtual Private Cloud (VPC)", "AWS::EC2::VPC"),
    "ecs": ("Amazon ECS", "AWS::ECS::Service"),
    "eks": ("Amazon EKS", "AWS::EKS::Cluster"),
    "rds": ("Amazon RDS", "AWS::RDS::DBInstance"),
    "kinesis": ("Amazon Kinesis", "AWS::Kinesis::Stream"),
    "apigateway": ("Amazon API Gateway", "AWS::ApiGateway::RestApi"),
    "apigatewayv2": ("Amazon API Gateway v2", "AWS::ApiGatewayV2::Api"),
    "cloudfront": ("Amazon CloudFront", "AWS::CloudFront::Distribution"),
    "stepfunctions": ("AWS Step Functions", "AWS::StepFunctions::StateMachine"),
    "cognito": ("Amazon Cognito", "AWS::Cognito::UserPool"),
    "efs": ("Amazon EFS", "AWS::EFS::FileSystem"),
    "elasticache": ("Amazon ElastiCache", "AWS::ElastiCache::CacheCluster"),
    "ssm": ("AWS Systems Manager", "AWS::SSM::Parameter"),
    "glue": ("AWS Glue", "AWS::Glue::Job"),
    "athena": ("Amazon Athena", "AWS::Athena::WorkGroup"),
    "guardduty": ("Amazon GuardDuty", "AWS::GuardDuty::Detector"),
}

# CDK construct segments that are NOT standalone services (skip as service axis).
# `iam` is skipped by design (every service uses IAM implicitly;
# only report it for IAM-specific features, which a plain import is not).
CDK_SKIP_SEGMENTS = {"core", "iam", "assertions", "custom-resources"}

MAX_FILE_BYTES = 2_000_000  # skip pathologically large files


# --------------------------------------------------------------------------- #
# Detection record.
# --------------------------------------------------------------------------- #
class Detection:
    """One detected capability with provenance. axis in {service, cfn, api}."""

    __slots__ = ("axis", "identifier", "service", "endpoint_prefix", "file",
                 "line", "method", "confidence", "evidence_locations",
                 "attributes")

    def __init__(self, axis, identifier, service, file, line, method, confidence):
        self.axis = axis
        self.identifier = identifier      # e.g. "AWS::Lambda::Function", "S3+PutObject", "Amazon S3"
        self.service = service            # canonical SdkServiceId when known, else ""
        self.endpoint_prefix = ""         # CloudTrail-style prefix (SFN->"states"); set by grounding
        self.file = file
        self.line = line
        self.method = method              # detectionMethod (see below)
        self.confidence = confidence      # "high" | "medium" | "low"
        # Every distinct file:line this capability was found at. Populated during
        # dedupe so a capability found in many packages shows ALL its locations,
        # not just the first — otherwise a deduped report looks like only one
        # package was scanned. Starts as this detection's own single location.
        self.evidence_locations = None
        # Config/runtime properties extracted from IaC for this capability, as
        # {property_name: [observed values]} — e.g. {"runtime": ["java17"]}.
        # Populated by the property-extraction pass (CFN/Terraform block-walk)
        # and unioned across all resources of this type during dedupe, so the
        # report shows "Lambda runtimes in use: java17, python3.9" rather than
        # per-resource noise. Values are literals only; a variable/import value
        # is recorded as "<unresolved>" — never a guessed default.
        self.attributes = None

    def key(self):
        return (self.axis, self.identifier)

    def _one_location(self):
        """This detection's own single `file:line` (or bare `file` when line==0,
        e.g. CloudTrail)."""
        if self.line:
            return f"{self.file}:{self.line}"
        return str(self.file)

    def evidence(self, max_shown=3):
        """Human-readable provenance. After dedupe, a capability may have been
        found in several places (across packages/files); show up to `max_shown`
        with a `(+N more)` tail so the report reflects real coverage rather than
        a single first-hit. Falls back to the single location pre-dedupe."""
        locs = self.evidence_locations or [self._one_location()]
        if len(locs) <= max_shown:
            return ", ".join(locs)
        return ", ".join(locs[:max_shown]) + f" (+{len(locs) - max_shown} more)"

    def to_dict(self):
        return {
            "axis": self.axis,
            "identifier": self.identifier,
            "service": self.service,
            "serviceEndpointPrefix": self.endpoint_prefix,
            "file": self.file,
            "line": self.line,
            "detectionMethod": self.method,
            # All distinct locations this capability was found at (populated by
            # dedupe). Shows true coverage across packages/files, not just the
            # first hit. Falls back to the single location pre-dedupe.
            "evidenceLocations": self.evidence_locations or [self._one_location()],
            # Config/runtime properties (runtime, engineVersion, instanceType...)
            # extracted from IaC, each mapping to the sorted distinct values seen.
            # Omitted when empty so the schema stays lean for detections that have
            # no property depth (services, api ops).
            **({"attributes": {k: sorted(v) for k, v in self.attributes.items()}}
               if self.attributes else {}),
        }


# --------------------------------------------------------------------------- #
# CloudFormation / SAM / CDK-synth template parsing.
# --------------------------------------------------------------------------- #
_CFN_TYPE_RE = re.compile(r"AWS::([A-Za-z0-9]+)::([A-Za-z0-9]+)")
_SAM_TYPE_RE = re.compile(r"AWS::Serverless::([A-Za-z0-9]+)")

# SAM transform resource types -> the CFN service they imply (for service axis).
_SAM_SERVICE = {
    "Function": "Lambda",
    "Api": "ApiGateway",
    "HttpApi": "ApiGatewayV2",
    "SimpleTable": "DynamoDB",
    "StateMachine": "StepFunctions",
    "LayerVersion": "Lambda",
    "Application": "Serverless",
}


def parse_cfn_template(text, rel_path, is_synth):
    """Extract AWS::Service::Resource types from a CFN/SAM template body.

    Works on both YAML and JSON without a YAML parser: CFN resource types are
    always the literal string 'AWS::Service::Resource', so a line-scan for that
    token is exact and format-agnostic. is_synth raises confidence to high
    (synthesized templates are ground truth). Returns a list[Detection].
    """
    detections = []
    method = "cdk-synth" if is_synth else "iac-cfn"
    confidence = "high"  # CFN types are unambiguous regardless of source
    for line_num, line in enumerate(text.splitlines(), 1):
        # SAM serverless types first (AWS::Serverless::Function etc.)
        for m in _SAM_TYPE_RE.finditer(line):
            sam_kind = m.group(1)
            service = _SAM_SERVICE.get(sam_kind, "Serverless")
            # SAM expands to real CFN types at deploy; record the service +
            # the SAM type as the cfn identifier (join tolerates the leaf).
            detections.append(Detection(
                "cfn", f"AWS::Serverless::{sam_kind}", service,
                rel_path, line_num, "iac-sam", confidence))
        for m in _CFN_TYPE_RE.finditer(line):
            service, resource = m.group(1), m.group(2)
            if service == "Serverless":
                continue  # handled above
            fqn = f"AWS::{service}::{resource}"
            detections.append(Detection(
                "cfn", fqn, service, rel_path, line_num, method, confidence))
    return detections


# --------------------------------------------------------------------------- #
# Terraform parsing.
# --------------------------------------------------------------------------- #
_TF_RESOURCE_RE = re.compile(
    r'(?:resource|data)\s+"(aws_[a-z0-9_]+)"', re.IGNORECASE)


def parse_terraform(text, rel_path):
    """Extract aws_* resource / data block types from Terraform HCL.

    Terraform type names (aws_lambda_function) map to CFN types via a separate
    table (see terraform_to_cfn); here we record the raw tf type as the
    identifier and derive the service from the tf provider segment.
    """
    detections = []
    for line_num, line in enumerate(text.splitlines(), 1):
        for m in _TF_RESOURCE_RE.finditer(line):
            tf_type = m.group(1).lower()
            cfn = TF_TO_CFN.get(tf_type)
            if cfn:
                service = cfn.split("::")[1]
                detections.append(Detection(
                    "cfn", cfn, service, rel_path, line_num,
                    "iac-terraform", "high"))
            else:
                # Unmapped tf type — still a service signal via the provider
                # segment (aws_dynamodb_table -> dynamodb). Medium confidence:
                # we know the service, not the exact CFN type.
                seg = tf_type[len("aws_"):].split("_", 1)[0]
                detections.append(Detection(
                    "service", _tf_service_display(seg), seg,
                    rel_path, line_num, "iac-terraform", "medium"))
    return detections


# --------------------------------------------------------------------------- #
# Config / runtime PROPERTY extraction.
#
# The parsers above answer "which resource types exist". This pass answers
# "how are they configured" — Lambda runtime, RDS/ElastiCache/EMR engine
# versions, EC2 instance types, etc. The values already sit in the same files;
# we just have to bind a property line to the resource block it lives in.
#
# Mechanism (proven against an adversarial fixture, see docs/):
#   * ONE forward pass; ONE "current block" state variable (not two pointers).
#   * A `Type: AWS::X::Y` line ENTERS a block; we remember its type + indent.
#   * A property line binds to that block only while indented DEEPER, and only
#     at the DIRECT-property depth — so a same-named key nested inside a sub-map
#     (e.g. Environment.Variables.Runtime) does NOT mis-bind.
#   * A dedent to/under the block's indent LEAVES the block.
# Determinism holds (regex/indent only, no LLM). A value that is a variable /
# intrinsic / import is recorded as "<unresolved>" — never a guessed default.
#
# NOTE ON CDK: we deliberately do NOT chase properties through CDK *source*
# (wrappers like SecureFunction pass runtime in from another file — unresolvable
# by regex). Instead we run this pass on `cdk synth` output (cdk.out/*.template
# .json), which is fully-resolved CloudFormation where every property is a
# literal — so synthesized CDK yields COMPLETE property depth for free.
# --------------------------------------------------------------------------- #

# CFN resource type -> {CFN property key: emitted attribute name}. Only the
# launch-relevant, high-signal properties; extend as needed. Keys are matched
# case-sensitively against the CFN/SAM property name.
_CFN_PROPERTY_CATALOG = {
    "AWS::Lambda::Function": {
        "Runtime": "runtime", "MemorySize": "memory",
        "Timeout": "timeout", "Architectures": "architecture"},
    "AWS::Serverless::Function": {
        "Runtime": "runtime", "MemorySize": "memory",
        "Timeout": "timeout", "Architectures": "architecture"},
    "AWS::EC2::Instance": {"InstanceType": "instanceType", "ImageId": "ami"},
    "AWS::RDS::DBInstance": {
        "Engine": "engine", "EngineVersion": "engineVersion",
        "DBInstanceClass": "instanceClass", "AllocatedStorage": "allocatedStorage"},
    "AWS::RDS::DBCluster": {
        "Engine": "engine", "EngineVersion": "engineVersion"},
    "AWS::ElastiCache::CacheCluster": {
        "Engine": "engine", "EngineVersion": "engineVersion",
        "CacheNodeType": "nodeType"},
    "AWS::ElastiCache::ReplicationGroup": {
        "Engine": "engine", "EngineVersion": "engineVersion",
        "CacheNodeType": "nodeType"},
    "AWS::EMR::Cluster": {"ReleaseLabel": "releaseLabel"},
    "AWS::DynamoDB::Table": {"BillingMode": "billingMode"},
    "AWS::OpenSearchService::Domain": {"EngineVersion": "engineVersion"},
    "AWS::ECS::TaskDefinition": {"Cpu": "cpu", "Memory": "memory"},
    "AWS::EKS::Cluster": {"Version": "version"},
    "AWS::Glue::Job": {"GlueVersion": "glueVersion", "WorkerType": "workerType"},
}

# key: value  — captures the property name and the rest of the line as value.
_CFN_KV_RE = re.compile(r'^(\s*)([A-Za-z0-9]+)\s*:\s*(.+?)\s*$')
# A value we cannot resolve to a literal. Two families:
#   CFN: intrinsics / refs / templating   (!Ref, !GetAtt, ${...}, Fn::, {, [)
#   Terraform: variable & expression refs  (var.x, local.x, data.x, module.x,
#     each.x, count.x, try(...), func calls, [for ...], ternaries, interpolation)
# If the value isn't a plain literal, we record "<unresolved>" rather than
# emitting a variable name as though it were a resolved value (never mis-claim —
# a var reference is NOT the runtime value).
_UNRESOLVED_RE = re.compile(
    r'^(!'                      # CFN short intrinsic  !Ref / !GetAtt
    r'|\{|\['                   # object/array/for-expr start
    r'|Fn::'                    # CFN long intrinsic
    r'|\$\{'                    # ${...} interpolation
    r'|<'                       # already-marked
    r'|var\.|local\.|data\.'    # terraform references
    r'|module\.|each\.|count\.'
    r'|try\(|[A-Za-z_][A-Za-z0-9_]*\('  # try(...) / any function call
    r')')
# A resolved value must ALSO not contain interpolation or a ternary anywhere.
_HAS_EXPR_RE = re.compile(r'\$\{|\?|(?<![:=])==|&&|\|\|')


def _indent_of(line):
    return len(line) - len(line.lstrip(" "))


def _clean_value(raw):
    """Normalize a CFN/TF scalar value: strip quotes/commas; flag unresolved
    (intrinsic/ref/variable/expression) values rather than guessing. A value
    only survives as a literal if it starts like a literal AND has no embedded
    interpolation or ternary. Returns a string."""
    v = raw.strip().rstrip(",")
    # Strip a trailing line comment that rode along from the source (YAML `#`,
    # HCL `#`/`//`). Only when OUTSIDE quotes — a `#` inside a quoted string is
    # part of the value. Cheap heuristic: if the value starts with a quote, cut
    # at the closing quote; otherwise cut at the first ` #` / ` //`.
    if v[:1] in ('"', "'"):
        q = v[0]
        end = v.find(q, 1)
        if end != -1:
            v = v[:end + 1]
    else:
        for marker in (" #", "\t#", " //", "\t//"):
            idx = v.find(marker)
            if idx != -1:
                v = v[:idx].rstrip()
    if not v or _UNRESOLVED_RE.match(v) or _HAS_EXPR_RE.search(v):
        return "<unresolved>"
    v = v.strip('"\'')
    # Sentinels / empty are not real config values (e.g. the `null` fallback in
    # try(each.value.x, var.x, null), or an empty string). Treat as unresolved.
    if v == "" or v.lower() in ("null", "none", "nil"):
        return "<unresolved>"
    return v


# --------------------------------------------------------------------------- #
# Reference resolution — resolve bare variable/parameter references to their
# declared values.
#
# A property value that is a BARE reference to a variable/parameter declared in
# the SAME scan scope (a TF `variable "x" { default = ... }` / `locals`, or a
# CFN `Parameters` entry with a `Default:`) is resolved to that default. This
# covers the common "declared with a default" case deterministically. We do NOT
# chase values across module boundaries, tfvars, deploy-time inputs, ternaries,
# or wrapper constructs — those stay <unresolved> (that fidelity comes from
# running `cdk synth` / `terraform plan` first; see README). No hardcoded
# per-service value patterns: this is generic reference->default resolution.
# --------------------------------------------------------------------------- #
# Bare references we will resolve (nothing else — an expression around the ref
# is deliberately left unresolved rather than partially guessed).
_TF_BARE_REF_RE = re.compile(r'^(?:var|local)\.([A-Za-z_][A-Za-z0-9_-]*)$')
_CFN_BARE_REF_RE = re.compile(
    r'^(?:!Ref\s+([A-Za-z0-9]+)'          # !Ref Foo
    r'|Ref:\s*([A-Za-z0-9]+)'             # Ref: Foo
    r'|\$\{([A-Za-z0-9]+)\})$')           # ${Foo}  (bare, whole value)


def resolve_value(raw, symbols):
    """Resolve a property value to the SET of literal values it could take:
      * a plain literal              -> {literal}
      * a bare var/local/!Ref whose name is known in `symbols` (same-scope
        defaults + repo-wide constants/tfvars) -> the symbol's literal(s)
      * anything else (expression, ternary, unknown ref, cross-module) -> {"<unresolved>"}
    Returning a set lets an ambiguous variable (different values in different
    tfvars/constants) report ALL observed values — if the repo declares both
    m5.large and m5.xlarge, both are reported. Never guesses a value the repo
    does not contain."""
    v = (raw or "").strip().rstrip(",")
    # Bare reference we might resolve against the symbol table.
    bare = v.strip('"\'')
    name = None
    m = _TF_BARE_REF_RE.match(bare)
    if m:
        name = m.group(1)
    else:
        m = _CFN_BARE_REF_RE.match(bare)
        if m:
            name = m.group(1) or m.group(2) or m.group(3)
    if name is not None:
        vals = symbols.get(name) if symbols else None
        return set(vals) if vals else {"<unresolved>"}
    # Not a reference: accept only if it's a clean literal.
    return {_clean_value(v)}


def collect_tfvars(text):
    """Parse a Terraform *.tfvars / *.auto.tfvars file: top-level `name = <literal>`
    assignments. Returns {name: literal}. Nested blocks are ignored."""
    defaults = {}
    depth = 0
    assign = re.compile(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$')
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if depth == 0:
            m = assign.match(stripped)
            if m:
                lit = _clean_value(m.group(2))
                if lit != "<unresolved>":
                    defaults[m.group(1)] = lit
        depth += line.count("{") - line.count("}") + line.count("[") - line.count("]")
        if depth < 0:
            depth = 0
    return defaults


def collect_tf_variable_defaults(text):
    """Scan Terraform HCL for `variable "x" { ... default = <literal> }` and
    `locals { x = <literal> }`, returning {name: literal_default}. Only literal
    defaults are captured; an expression/ref default is skipped (the property
    stays unresolved rather than resolving to another reference)."""
    defaults = {}
    lines = text.splitlines()
    var_open = re.compile(r'^\s*variable\s+"([A-Za-z_][A-Za-z0-9_-]*)"')
    default_re = re.compile(r'^\s*default\s*=\s*(.+?)\s*$')
    locals_open = re.compile(r'^\s*locals\s*\{')
    local_assign = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$')
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        vm = var_open.match(line)
        if vm:
            name = vm.group(1)
            # Single-line form: variable "x" { default = "lit" }
            inline = re.search(r'default\s*=\s*([^}]+?)\s*}', line)
            if inline:
                lit = _clean_value(inline.group(1))
                if lit != "<unresolved>":
                    defaults[name] = lit
                i += 1
                continue
            depth = line.count("{") - line.count("}")
            j = i + 1
            while j < n and depth > 0:
                dm = default_re.match(lines[j])
                if dm and depth == 1:
                    lit = _clean_value(dm.group(1))
                    if lit != "<unresolved>":
                        defaults[name] = lit
                depth += lines[j].count("{") - lines[j].count("}")
                j += 1
            i = j
            continue
        if locals_open.match(line):
            depth = line.count("{") - line.count("}")
            j = i + 1
            while j < n and depth > 0:
                if depth == 1:
                    am = local_assign.match(lines[j])
                    if am:
                        lit = _clean_value(am.group(2))
                        if lit != "<unresolved>":
                            defaults[am.group(1)] = lit
                depth += lines[j].count("{") - lines[j].count("}")
                j += 1
            i = j
            continue
        i += 1
    return defaults


def collect_cfn_parameter_defaults(text):
    """Scan a CFN/SAM template's `Parameters:` section for entries with a
    `Default:`, returning {ParamName: literal_default}. Single indent-based
    pass; only literal defaults are captured."""
    defaults = {}
    in_params = False
    params_indent = None
    cur_param = None
    param_indent = None
    for line in text.splitlines():
        if not line.strip():
            continue
        ind = _indent_of(line)
        stripped = line.strip()
        if re.match(r'^Parameters\s*:\s*$', stripped):
            in_params, params_indent = True, ind
            continue
        if in_params and ind <= params_indent:
            # dedented out of the Parameters block (next top-level section)
            in_params = False
        if not in_params:
            continue
        kv = _CFN_KV_RE.match(line)
        # A parameter name is a bare `Name:` (no inline value) one level in.
        name_only = re.match(r'^\s*([A-Za-z0-9]+)\s*:\s*$', line)
        if name_only and ind == params_indent + 2:
            cur_param, param_indent = name_only.group(1), ind
            continue
        if cur_param and kv and kv.group(2) == "Default" and ind > param_indent:
            lit = _clean_value(kv.group(3))
            if lit != "<unresolved>":
                defaults[cur_param] = lit
    return defaults


def extract_cfn_properties(text, rel_path, is_synth):
    """Extract config properties from a CFN/SAM template (YAML or JSON, no
    parser dependency) via single-pass indent-based block-association. Returns
    a list of (cfn_type, rel_path, {attr_name: value}) — one entry per resource
    block that had at least one catalog property. Confidence rides the caller."""
    results = []
    # cur: the open resource block. "indent" is the Type line's indent; in CFN,
    # Type: and its sibling Properties: share this indent, and real properties
    # are strictly DEEPER. "prop_indent" is fixed to the first property line's
    # indent — the direct-property depth. Only keys at that exact depth bind, so
    # a same-named key nested in a sub-map (Environment.Variables.Runtime) can
    # never mis-bind, regardless of document order.
    cur = None

    def _flush(c):
        if c and c["props"]:
            results.append((c["type"], rel_path, c["props"]))

    for line in text.splitlines():
        if not line.strip():
            continue
        ind = _indent_of(line)
        m = _CFN_TYPE_RE.search(line)
        if m:
            _flush(cur)
            cur = {"type": f"AWS::{m.group(1)}::{m.group(2)}",
                   "indent": ind, "prop_indent": None, "props": {}}
            continue
        if cur is None:
            continue
        # Strictly-shallower than the Type line = out of this resource (the next
        # logical id / sibling resource). Type's own sibling Properties: shares
        # the indent, so it does NOT close the block.
        if ind < cur["indent"]:
            _flush(cur)
            cur = None
            continue
        wanted = _CFN_PROPERTY_CATALOG.get(cur["type"])
        if not wanted:
            continue
        kv = _CFN_KV_RE.match(line)
        if not kv:
            continue
        # The first kv line deeper than the Type line fixes the direct-property
        # depth for this block. (Properties: itself has no value, so it isn't a
        # kv match and won't set this.)
        if cur["prop_indent"] is None and ind > cur["indent"]:
            cur["prop_indent"] = ind
        key, val = kv.group(2), kv.group(3)
        if ind != cur["prop_indent"] or key not in wanted:
            continue
        # Store the RAW value; resolution (literal / ref->default / <unresolved>)
        # happens later in detect() against the repo-wide symbol table.
        if key not in cur["props"]:
            cur["props"][key] = val
    _flush(cur)
    # Re-key raw CFN property names to emitted attribute names.
    out = []
    for cfn_type, rp, props in results:
        wanted = _CFN_PROPERTY_CATALOG[cfn_type]
        out.append((cfn_type, rp, {wanted[k]: v for k, v in props.items()}))
    return out


# Terraform: aws_* resource -> {hcl argument: emitted attribute name}.
_TF_PROPERTY_CATALOG = {
    "aws_lambda_function": {
        "runtime": "runtime", "memory_size": "memory",
        "timeout": "timeout", "architectures": "architecture"},
    "aws_instance": {"instance_type": "instanceType", "ami": "ami"},
    "aws_db_instance": {
        "engine": "engine", "engine_version": "engineVersion",
        "instance_class": "instanceClass", "allocated_storage": "allocatedStorage"},
    "aws_rds_cluster": {
        "engine": "engine", "engine_version": "engineVersion"},
    "aws_elasticache_cluster": {
        "engine": "engine", "engine_version": "engineVersion",
        "node_type": "nodeType"},
    "aws_elasticache_replication_group": {
        "engine": "engine", "engine_version": "engineVersion",
        "node_type": "nodeType"},
    "aws_emr_cluster": {"release_label": "releaseLabel"},
    "aws_dynamodb_table": {"billing_mode": "billingMode"},
    "aws_opensearch_domain": {"engine_version": "engineVersion"},
    "aws_eks_cluster": {"version": "version"},
    "aws_glue_job": {"glue_version": "glueVersion", "worker_type": "workerType"},
}
# tf resource -> the CFN type we attach properties to (must match TF_TO_CFN
# where present so property depth lands on the same deduped detection).
_TF_TO_CFN_FOR_PROPS = {
    "aws_lambda_function": "AWS::Lambda::Function",
    "aws_instance": "AWS::EC2::Instance",
    "aws_db_instance": "AWS::RDS::DBInstance",
    "aws_rds_cluster": "AWS::RDS::DBCluster",
    "aws_elasticache_cluster": "AWS::ElastiCache::CacheCluster",
    "aws_elasticache_replication_group": "AWS::ElastiCache::ReplicationGroup",
    "aws_emr_cluster": "AWS::EMR::Cluster",
    "aws_dynamodb_table": "AWS::DynamoDB::Table",
    "aws_opensearch_domain": "AWS::OpenSearchService::Domain",
    "aws_eks_cluster": "AWS::EKS::Cluster",
    "aws_glue_job": "AWS::Glue::Job",
}
_TF_RESOURCE_OPEN_RE = re.compile(
    r'^\s*(?:resource|data)\s+"(aws_[a-z0-9_]+)"')
_TF_ARG_RE = re.compile(r'^\s*([a-z0-9_]+)\s*=\s*(.+?)\s*$')


def extract_tf_properties(text, rel_path):
    """Extract config properties from Terraform HCL via brace-depth block
    tracking. Returns (cfn_type, rel_path, {attr: value}) per aws_* block that
    had a catalog argument. Only top-level (depth-1) arguments bind, so nested
    blocks (e.g. an `ebs_block_device { ... }`) don't leak same-named args."""
    results = []
    cur = None  # {"tf_type", "props": {}}
    depth = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        opener = _TF_RESOURCE_OPEN_RE.match(line)
        if opener and depth == 0:
            if cur and cur["props"]:
                results.append(cur)
            cur = {"tf_type": opener.group(1), "props": {}}
            depth = line.count("{") - line.count("}")
            continue
        if cur is not None:
            # A catalog argument binds only at the resource's top level (depth 1
            # while the block is open). Check BEFORE updating depth for this line.
            if depth == 1:
                arg = _TF_ARG_RE.match(line)
                if arg:
                    wanted = _TF_PROPERTY_CATALOG.get(cur["tf_type"], {})
                    key = arg.group(1)
                    if key in wanted and wanted[key] not in cur["props"]:
                        # Store RAW; resolved later against the symbol table.
                        cur["props"][wanted[key]] = arg.group(2)
            depth += line.count("{") - line.count("}")
            if depth <= 0:  # block closed
                if cur["props"]:
                    results.append(cur)
                cur = None
                depth = 0
    if cur and cur["props"]:
        results.append(cur)
    out = []
    for blk in results:
        cfn = _TF_TO_CFN_FOR_PROPS.get(blk["tf_type"])
        if cfn:
            out.append((cfn, rel_path, blk["props"]))
    return out


def _tf_service_display(seg):
    """Best-effort display name for an unmapped terraform provider segment."""
    return seg


# A pragmatic, extensible Terraform->CFN map for the common resource types.
# NOT exhaustive — unmapped types still yield a service-level signal. This is
# a curated Terraform-type -> CFN-type table; extend as new types are needed.
TF_TO_CFN = {
    "aws_lambda_function": "AWS::Lambda::Function",
    "aws_dynamodb_table": "AWS::DynamoDB::Table",
    "aws_s3_bucket": "AWS::S3::Bucket",
    "aws_sns_topic": "AWS::SNS::Topic",
    "aws_sqs_queue": "AWS::SQS::Queue",
    "aws_kms_key": "AWS::KMS::Key",
    "aws_iam_role": "AWS::IAM::Role",
    "aws_ecs_cluster": "AWS::ECS::Cluster",
    "aws_ecs_service": "AWS::ECS::Service",
    "aws_ecs_task_definition": "AWS::ECS::TaskDefinition",
    "aws_api_gateway_rest_api": "AWS::ApiGateway::RestApi",
    "aws_apigatewayv2_api": "AWS::ApiGatewayV2::Api",
    "aws_cloudfront_distribution": "AWS::CloudFront::Distribution",
    "aws_rds_cluster": "AWS::RDS::DBCluster",
    "aws_db_instance": "AWS::RDS::DBInstance",
    "aws_kinesis_stream": "AWS::Kinesis::Stream",
    "aws_secretsmanager_secret": "AWS::SecretsManager::Secret",
    "aws_ssm_parameter": "AWS::SSM::Parameter",
    "aws_cloudwatch_log_group": "AWS::Logs::LogGroup",
    "aws_eventbridge_rule": "AWS::Events::Rule",
    "aws_cloudwatch_event_rule": "AWS::Events::Rule",
    "aws_efs_file_system": "AWS::EFS::FileSystem",
    "aws_elasticache_cluster": "AWS::ElastiCache::CacheCluster",
    "aws_cognito_user_pool": "AWS::Cognito::UserPool",
    "aws_stepfunctions_state_machine": "AWS::StepFunctions::StateMachine",
    "aws_sfn_state_machine": "AWS::StepFunctions::StateMachine",
    "aws_glue_job": "AWS::Glue::Job",
    "aws_athena_workgroup": "AWS::Athena::WorkGroup",
    "aws_vpc": "AWS::EC2::VPC",
    "aws_instance": "AWS::EC2::Instance",
    "aws_eks_cluster": "AWS::EKS::Cluster",
}


# --------------------------------------------------------------------------- #
# SDK dependency-manifest parsing — service-level signal straight from the
# declared dependencies, no code execution required.
# --------------------------------------------------------------------------- #
# JS: @aws-sdk/client-<service> (v3) is ONE package per service — near-perfect
# service signal. aws-sdk (v2) is the whole SDK (service unknown from manifest).
_JS_V3_CLIENT_RE = re.compile(r'"@aws-sdk/client-([a-z0-9-]+)"')
_JS_CDK_RE = re.compile(r'"(?:aws-cdk-lib|@aws-cdk/aws-([a-z0-9-]+))"')

# Python: boto3/botocore are whole-SDK; specific service not in the manifest.
# Java: software.amazon.awssdk:<service> (v2) is per-service.
_JAVA_V2_ARTIFACT_RE = re.compile(
    r'software\.amazon\.awssdk[:\s"\']+([a-z0-9-]+)')
# Go: github.com/aws/aws-sdk-go-v2/service/<service> is per-service.
_GO_SDK_RE = re.compile(
    r'github\.com/aws/aws-sdk-go-v2/service/([a-z0-9]+)')

# Wrapper libraries -> the AWS service they imply (the deterministic version of
# the wrapper -> service inference; curated, must stay accurate).
WRAPPER_LIBS = {
    "electrodb": "DynamoDB", "dynamoose": "DynamoDB", "pynamodb": "DynamoDB",
    "middy": "Lambda", "@middy/core": "Lambda",
    "aws-lambda-powertools": "Lambda", "powertools-lambda": "Lambda",
    "multer-s3": "S3", "s3-presigned-post": "S3",
    "amazon-cognito-identity-js": "Cognito",
}


def parse_manifest(text, rel_path, filename):
    """Detect service-level dependencies from a build/dependency manifest.

    Manifest signal is service-level (which SDK clients / constructs are pulled
    in), not API-level. High confidence for per-service SDK packages
    (@aws-sdk/client-s3), medium for wrapper libraries (inferred).
    """
    detections = []

    def add_service(sdk_service, line_num, method, confidence):
        detections.append(Detection(
            "service", sdk_service_display(sdk_service), sdk_service,
            rel_path, line_num, method, confidence))

    for line_num, line in enumerate(text.splitlines(), 1):
        for m in _JS_V3_CLIENT_RE.finditer(line):
            add_service(m.group(1).replace("-", ""), line_num,
                        "sdk-manifest", "high")
        for m in _JAVA_V2_ARTIFACT_RE.finditer(line):
            svc = m.group(1)
            if svc not in ("bom", "aws-sdk-java", "sdk-core"):
                add_service(svc, line_num, "sdk-manifest", "high")
        for m in _GO_SDK_RE.finditer(line):
            add_service(m.group(1), line_num, "sdk-manifest", "high")
        # Scoped internal construct libs in a manifest imply CDK usage but not a
        # specific service (the service shows up at the import site) — skip here
        # to avoid noise; the .ts CDK-import parser handles per-service signal.
        # Wrapper libraries (inferred).
        for lib, service in WRAPPER_LIBS.items():
            if f'"{lib}"' in line or f"'{lib}'" in line or f"{lib}==" in line \
                    or re.search(rf'(^|[\s"\']){re.escape(lib)}([\s"\'=><~^]|$)', line):
                detections.append(Detection(
                    "service", sdk_service_display(service.lower()), service.lower(),
                    rel_path, line_num, "sdk-manifest-wrapper", "medium"))
    return detections


def sdk_service_display(sdk_service):
    """Map a short SDK service id to a display name where we know it, else the
    id verbatim. The downstream join keys on the short id anyway, so an
    unknown display name never breaks the join — it only affects readability."""
    return SDK_SERVICE_DISPLAY.get(sdk_service.lower(), sdk_service)


# Display-name -> short id, so a service-axis detection whose `service` slot
# holds a display name ("Amazon S3") still normalizes to the same key ("s3").
_DISPLAY_TO_ID = None


def _display_to_id():
    global _DISPLAY_TO_ID
    if _DISPLAY_TO_ID is None:
        _DISPLAY_TO_ID = {v.lower(): k for k, v in SDK_SERVICE_DISPLAY.items()}
    return _DISPLAY_TO_ID


def canonical_service_id(d):
    """Return the ONE canonical short service id for a detection, derived from the
    most authoritative signal available per axis:
      * cfn  -> the <Service> segment of AWS::<Service>::<Type>, lowercased
      * api  -> the <ServiceId> segment of <ServiceId>+<Operation>, lowercased
      * service -> its existing short id, or the display name mapped back to id
    Falls back to the detection's current `service` (lowercased) or "". The
    result is a stable, lowercase key that is identical across all three axes for
    the same service, so a downstream consumer can group by it. Display spelling
    lives in Detection.identifier (unchanged); only this join key is normalized."""
    axis = d.axis
    if axis == "cfn":
        segs = d.identifier.split("::")
        if len(segs) >= 2 and segs[0] == "AWS":
            return segs[1].lower()
    if axis == "api" and "+" in d.identifier:
        return d.identifier.split("+", 1)[0].lower()
    # service axis (or fallback): prefer the carried short id; if it looks like a
    # display name, map it back; else lowercase whatever we have.
    svc = (d.service or "").strip()
    if not svc:
        # service-axis identifier may itself be a display name.
        svc = (d.identifier or "").strip()
    low = svc.lower()
    if low in _display_to_id():
        return _display_to_id()[low]
    # Already a short id (no spaces) -> lowercase it; multi-word display with no
    # mapping -> collapse to alphanumeric lower as a last resort.
    if " " in low or "(" in low:
        return "".join(c for c in low if c.isalnum())
    return low


# Short-id -> display name for the common services (readability only).
SDK_SERVICE_DISPLAY = {
    "s3": "Amazon S3", "dynamodb": "Amazon DynamoDB", "lambda": "AWS Lambda",
    "sns": "Amazon SNS", "sqs": "Amazon SQS", "kms": "AWS KMS",
    "ec2": "Amazon EC2", "ecs": "Amazon ECS", "eks": "Amazon EKS",
    "apigateway": "Amazon API Gateway", "apigatewayv2": "Amazon API Gateway v2",
    "cloudfront": "Amazon CloudFront", "rds": "Amazon RDS",
    "kinesis": "Amazon Kinesis", "secretsmanager": "AWS Secrets Manager",
    "ssm": "AWS Systems Manager", "cloudwatch": "Amazon CloudWatch",
    "stepfunctions": "AWS Step Functions", "sfn": "AWS Step Functions",
    "cognito": "Amazon Cognito", "cognitoidentityprovider": "Amazon Cognito",
    "athena": "Amazon Athena", "glue": "AWS Glue", "efs": "Amazon EFS",
    "elasticache": "Amazon ElastiCache", "eventbridge": "Amazon EventBridge",
}


# --------------------------------------------------------------------------- #
# SDK call-site parsing (API-operation signal).
#
# Design: every emitted api-axis Detection carries BOTH the owning short service
# id (Detection.service, e.g. "s3") AND the identifier in canonical
# `SdkServiceId+Operation` form (e.g. "S3+PutObject"), so the availability API
# join keys correctly on the SDK service id + operation. Service
# attribution per language uses the SDK's own encoding rather than guessing:
#   * Java v2/v1 — the model/client IMPORT names both service and operation
#   * Python boto3 — bind `x = boto3.client("s3")`, attribute `x.get_object()`
#   * TS v3 — bind command class -> service via the `@aws-sdk/client-*` import
#   * Go v2 — service from the import path; PascalCase methods are operations
# --------------------------------------------------------------------------- #
_IMPORT_RE = re.compile(r"^\s*(?:import\s|from\s|.*require\s*\()")

# Operation-name -> canonical SdkServiceId is not needed; we already track the
# owning service. We DO normalize the service id to the SDK "service id" form
# the catalog uses (PascalCase-ish). The join normalizes both sides anyway, so
# we emit the short id verbatim and format the identifier as "<ServiceId>+<Op>".
def _op_identifier(service_id, operation):
    """Canonical `SdkServiceId+Operation`. A downstream join normalizes case, so
    the service segment casing here is cosmetic; use the known display id."""
    seg = SDK_SERVICE_ID.get(service_id.lower(), service_id)
    return f"{seg}+{operation}"


# Short service id -> the SdkServiceId spelling the capabilities catalog uses
# for API operations (cosmetic; join normalizes). Extend as needed.
SDK_SERVICE_ID = {
    "s3": "S3", "dynamodb": "DynamoDB", "lambda": "Lambda", "sns": "SNS",
    "sqs": "SQS", "kms": "KMS", "secretsmanager": "SecretsManager",
    "cloudwatch": "CloudWatch", "ec2": "EC2", "ecs": "ECS", "eks": "EKS",
    "kinesis": "Kinesis", "ssm": "SSM", "stepfunctions": "SFN", "sfn": "SFN",
    "cognitoidentityprovider": "CognitoIdentityProvider", "athena": "Athena",
    "glue": "Glue", "eventbridge": "EventBridge", "cloudwatchlogs": "CloudWatchLogs",
    "apigateway": "APIGateway", "rds": "RDS",
}

# Non-API boto3 attributes that look like methods but are not operations.
_BOTO_NONAPI = {
    "get_paginator", "get_waiter", "can_paginate", "close", "meta",
    "exceptions", "get_available_subresources", "resource", "client",
}
# Java/Go method names that are builder/util noise, not API operations.
_GENERIC_METHOD_NOISE = {
    "build", "builder", "create", "close", "toString", "equals", "hashCode",
    "String", "GoString", "Error", "of", "value", "name", "get", "set",
    "toBuilder", "sdkFields", "region", "credentialsProvider",
}


def snake_to_pascal(name):
    return "".join(part.capitalize() for part in name.split("_"))


def parse_ts_callsites(text, rel_path):
    """AWS SDK v3 (Command classes bound to their `@aws-sdk/client-*` import)
    and v2 (`new AWS.S3()` / service clients). v3 command names are globally
    unambiguous (PutObjectCommand -> PutObject); we bind each command to its
    service via the import so the api op carries the owning service."""
    detections = []
    # Phase 1: map imported command class -> service id, from the v3 imports.
    #   import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
    cmd_to_service = {}
    for m in re.finditer(
            r"import\s*\{([^}]*)\}\s*from\s*['\"]@aws-sdk/client-([a-z0-9-]+)['\"]",
            text):
        service_id = m.group(2).replace("-", "")
        for sym in m.group(1).split(","):
            sym = sym.strip().split(" as ")[0].strip()
            if sym.endswith("Command"):
                cmd_to_service[sym] = service_id
    # Phase 2: command instantiations.
    for line_num, line in enumerate(text.splitlines(), 1):
        if _IMPORT_RE.match(line):
            continue
        for m in re.finditer(r"new\s+([A-Z][A-Za-z0-9]+Command)\s*\(", line):
            cmd = m.group(1)
            op = cmd[:-len("Command")]
            if len(op) < 3:
                continue
            service_id = cmd_to_service.get(cmd, "")
            ident = _op_identifier(service_id, op) if service_id else op
            conf = "high" if service_id else "medium"
            detections.append(Detection(
                "api", ident, service_id, rel_path, line_num,
                "sdk-callsite-ts", conf))
    return detections


def parse_py_callsites(text, rel_path):
    """boto3: bind client/resource variables to their service, then attribute
    method calls on those variables to `Service+Operation`. Two-phase so
    `ddb = boto3.client("dynamodb"); ddb.put_item(...)` yields DynamoDB+PutItem.
    Also emits the service itself (high). Unbound method calls are ignored
    (avoids false positives from non-AWS objects)."""
    detections = []
    # Phase 1: variable -> service id.
    var_to_service = {}
    client_re = re.compile(
        r"""(\w+)\s*=\s*boto3\.(?:client|resource)\(\s*['"]([a-z0-9-]+)['"]""")
    for m in client_re.finditer(text):
        var_to_service[m.group(1)] = m.group(2).replace("-", "")
    # Also detect bare boto3.client("x") for the service axis even if unassigned.
    for m in re.finditer(
            r"""boto3\.(?:client|resource)\(\s*['"]([a-z0-9-]+)['"]""", text):
        svc = m.group(1).replace("-", "")
        detections.append(Detection(
            "service", sdk_service_display(svc), svc, rel_path,
            _lineno(text, m.start()), "sdk-callsite-py", "high"))
    if not var_to_service:
        return detections
    # Phase 2: <var>.<method>( on bound variables.
    var_alt = "|".join(re.escape(v) for v in var_to_service)
    method_re = re.compile(rf"\b({var_alt})\.([a-z][a-z0-9_]+)\s*\(")
    for line_num, line in enumerate(text.splitlines(), 1):
        for m in method_re.finditer(line):
            var, method = m.group(1), m.group(2)
            if method in _BOTO_NONAPI:
                continue
            svc = var_to_service[var]
            op = snake_to_pascal(method)
            detections.append(Detection(
                "api", _op_identifier(svc, op), svc, rel_path, line_num,
                "sdk-callsite-py", "high"))
    return detections


# Java v2 model/client import: software.amazon.awssdk.services.<svc>.model.<Op>Request
_JAVA_OP_IMPORT_RE = re.compile(
    r"software\.amazon\.awssdk\.services\.([a-z0-9]+)\.model\.([A-Z][A-Za-z0-9]+)(Request)\b")
# Java v1: com.amazonaws.services.<svc>.model.<Op>Request
_JAVA_V1_OP_IMPORT_RE = re.compile(
    r"com\.amazonaws\.services\.([a-z0-9]+)\.model\.([A-Z][A-Za-z0-9]+)(Request)\b")


def parse_java_callsites(text, rel_path):
    """Java SDK v2/v1 API operations from `...model.<Op>Request` imports — the
    import itself names both the service and the operation unambiguously (a
    `PutItemRequest` import under `services.dynamodb` == DynamoDB+PutItem). This
    is higher-signal than scanning call sites (Java builders obscure the verb).
    Emitted HIGH confidence."""
    detections = []
    for line_num, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if not stripped.startswith("import"):
            continue
        for rx in (_JAVA_OP_IMPORT_RE, _JAVA_V1_OP_IMPORT_RE):
            for m in rx.finditer(line):
                svc, op = m.group(1), m.group(2)
                if svc in ("core", "regions", "auth", "utils"):
                    continue
                if op in _GENERIC_METHOD_NOISE:
                    continue
                detections.append(Detection(
                    "api", _op_identifier(svc, op), svc, rel_path, line_num,
                    "sdk-java-op", "high"))
    return detections


# Go v2 import path -> service; client method calls -> operations.
_GO_SERVICE_IMPORT_RE = re.compile(
    r"github\.com/aws/aws-sdk-go-v2/service/([a-z0-9]+)")
_GO_METHOD_RE = re.compile(r"\.([A-Z][A-Za-z0-9]+)\s*\(")


def parse_go_callsites(text, rel_path):
    """Go SDK v2: derive the service(s) from the import path(s), then treat
    PascalCase client method calls as operations attributed to that service.
    When exactly one AWS service is imported in the file, attribution is
    unambiguous (high); with multiple, we still emit the op but at medium and
    without a definitive owning service."""
    services = [m.group(1) for m in _GO_SERVICE_IMPORT_RE.finditer(text)]
    detections = []
    if not services:
        return detections
    uniq_services = sorted(set(services))
    sole = uniq_services[0] if len(uniq_services) == 1 else ""
    # Service axis for each imported service.
    for svc in uniq_services:
        detections.append(Detection(
            "service", sdk_service_display(svc), svc, rel_path, 1,
            "sdk-go", "high"))
    for line_num, line in enumerate(text.splitlines(), 1):
        if _IMPORT_RE.match(line):
            continue
        for m in _GO_METHOD_RE.finditer(line):
            op = m.group(1)
            if len(op) < 4 or op in _GENERIC_METHOD_NOISE:
                continue
            if sole:
                detections.append(Detection(
                    "api", _op_identifier(sole, op), sole, rel_path,
                    line_num, "sdk-callsite-go", "medium"))
    return detections


def _lineno(text, offset):
    """1-based line number for a character offset into text."""
    return text.count("\n", 0, offset) + 1


# --------------------------------------------------------------------------- #
# CDK construct-import parsing (a dominant IaC signal in CDK codebases).
# --------------------------------------------------------------------------- #
# Sub-path style: aws-cdk-lib/aws-<service>, @aws-cdk/aws-<service> (v1), and
# org-scoped construct wrappers `@<scope>/<lib>-<service>`.
_CDK_IMPORT_RE = re.compile(
    r"(?:aws-cdk-lib/aws-([a-z0-9]+)"
    r"|@aws-cdk/aws-([a-z0-9]+)"
    r"|@[a-z0-9-]+/[a-z0-9]*cdk[a-z0-9]*/[a-z]+-([a-z0-9]+))")

# Barrel / namespaced style (CDK v2, the common modern form):
#   TS:  import { aws_ec2 as ec2, aws_lambda } from 'aws-cdk-lib'
#   PY:  from aws_cdk import aws_lambda / aws_cdk.aws_dynamodb.Table(...)
# Matches the `aws_<service>` submodule token wherever it appears.
_CDK_BARREL_RE = re.compile(r"\baws_([a-z0-9]+)\b")


def parse_cdk_imports(text, rel_path):
    """Detect AWS services + primary CFN types from CDK construct-library imports.

    Handles BOTH import styles:
      * sub-path: `import { Function } from 'aws-cdk-lib/aws-lambda'`
      * barrel:   `import { aws_lambda } from 'aws-cdk-lib'` (CDK v2) and the
                  Python `aws_cdk.aws_lambda` namespaced form.
    Service is HIGH confidence (the import is unambiguous); the primary CFN type
    is MEDIUM (a construct can create several resource types — the exact set
    comes from `cdk synth`, which supersedes this when present).
    """
    detections = []
    # Barrel form is only trusted when the file actually uses aws-cdk-lib /
    # aws_cdk, so a stray `aws_foo` variable elsewhere isn't misread as CDK.
    barrel_ok = ("aws-cdk-lib" in text or "aws_cdk" in text)
    for line_num, line in enumerate(text.splitlines(), 1):
        is_cdk_line = "cdk" in line or "motecdk" in line
        if not is_cdk_line and not barrel_ok:
            continue
        segs_here = []
        for m in _CDK_IMPORT_RE.finditer(line):
            segs_here.append(m.group(1) or m.group(2) or m.group(3))
        # Barrel `aws_<service>` tokens — only on lines that look CDK-related
        # (import lines, or lines referencing the aws_cdk namespace).
        if barrel_ok and ("aws_" in line):
            for m in _CDK_BARREL_RE.finditer(line):
                segs_here.append(m.group(1))
        for seg in segs_here:
            if not seg or seg in CDK_SKIP_SEGMENTS:
                continue
            info = CDK_SERVICE.get(seg)
            if info:
                display, cfn_type = info
                short = cfn_type.split("::")[1]
                detections.append(Detection(
                    "service", display, short, rel_path, line_num,
                    "cdk-construct", "high"))
                detections.append(Detection(
                    "cfn", cfn_type, short, rel_path, line_num,
                    "cdk-construct", "medium"))
            else:
                # Unknown segment — still a service signal (medium); the join
                # resolves the display name if it maps to a catalog service.
                detections.append(Detection(
                    "service", sdk_service_display(seg), seg, rel_path,
                    line_num, "cdk-construct", "medium"))
    return detections


# --------------------------------------------------------------------------- #
# IAM policy action parsing — a high-signal source of intended usage. An IAM
# policy statement declares, precisely, which service operations the code
# intends to use:
#     "Action": ["dynamodb:Query", "s3:GetObject"]   (CFN / policy JSON+YAML)
#     actions: ['events:PutRule', 'kms:Decrypt']      (CDK PolicyStatement)
# Both reduce to the universal IAM action token `service:Operation`. We match
# that token wherever it appears (quoted), which covers CFN, CDK, SAM policies,
# and standalone policy files uniformly. Grounding drops wildcards (`s3:*`) and
# any action that is not a real operation of a real service.
# --------------------------------------------------------------------------- #
# A quoted IAM action: "<service>:<Action>" — service is lowercase[+num-dot],
# action is an identifier (or * / prefix*, which grounding will drop).
_IAM_ACTION_RE = re.compile(r"""['"]([a-z][a-z0-9-]*):([A-Za-z][A-Za-z0-9*]*)['"]""")

# IAM action service prefix -> the SDK/SdkServiceId token grounding resolves.
# Most match directly (dynamodb, s3, sns...); a few IAM prefixes differ from the
# SDK id and are bridged here. Grounding still validates the operation, so an
# unmapped prefix simply fails to resolve rather than emitting a bad op.
_IAM_PREFIX_ALIASES = {
    "logs": "logs", "events": "events", "monitoring": "cloudwatch",
    "cloudwatch": "cloudwatch", "states": "sfn", "execute-api": "apigateway",
    "cognito-idp": "cognito-idp", "cognito-identity": "cognito-identity",
}


def parse_iam_actions(text, rel_path):
    """Extract `service:Operation` IAM actions as api-axis detections. The op is
    emitted in SdkServiceId+Operation form so it grounds/joins like any other
    api detection; wildcards and non-real actions are dropped by grounding.
    Medium confidence: an IAM grant states intent, which is strong signal, but is
    a permission (not proof the call is made). Only lines that look like a policy
    action context are considered, to avoid matching unrelated `word:word`."""
    detections = []
    # Cheap guard: only scan files that plausibly contain IAM actions.
    if not any(tok in text for tok in ('"Action"', "Action:", "actions:",
                                       "'Action'", "addToPolicy", "PolicyStatement",
                                       "iam:", "Statement")):
        return detections
    for line_num, line in enumerate(text.splitlines(), 1):
        for m in _IAM_ACTION_RE.finditer(line):
            svc, op = m.group(1), m.group(2)
            svc_token = _IAM_PREFIX_ALIASES.get(svc, svc)
            if "*" in op or not op:
                # Wildcard / prefix-glob (cloudwatch:Get*, s3:*). We can't name
                # the concrete operation, and expanding the glob would fabricate
                # ops the code may never call. But the SERVICE is unambiguously
                # touched — previously this line dropped the whole signal, making
                # a service vanish when its only evidence was a wildcard grant.
                # Emit a service-axis detection (low confidence: permission-only,
                # no specific op) and preserve the wildcard verbatim as evidence.
                det = Detection(
                    "service", svc_token, svc_token, rel_path, line_num,
                    "iam-wildcard", "low")
                det.attributes = {"wildcardActions": [f"{svc}:{op}"]}
                detections.append(det)
                continue
            # Emit in Service+Op form (grounding canonicalizes svc + validates op).
            detections.append(Detection(
                "api", f"{svc_token}+{op}", svc_token, rel_path, line_num,
                "iam-action", "medium"))
    return detections


# --------------------------------------------------------------------------- #
# CloudTrail log parsing — a SECOND, complementary input mode (opt-in via
# --cloudtrail). Where the code scan says "what the code CAN use", CloudTrail
# says "what ACTUALLY ran": each log record carries eventSource (service),
# eventName (operation), and awsRegion (where it ran). We read the delivered
# CloudTrail .json.gz / .json files DIRECTLY (stdlib gzip+json), so it stays a
# lightweight, dependency-free, offline-capable mode.
#
# Detections are api-axis (service+operation) + service-axis, carry the REAL
# region (unlike the code scan, which is region-less), detectionMethod
# 'cloudtrail', and HIGH confidence (the call demonstrably executed). Grounding
# still validates every op against the universe (drops fake/non-API events).
# --------------------------------------------------------------------------- #
def _iter_cloudtrail_records(path):
    """Yield CloudTrail event dicts from a file or a directory tree of
    .json/.json.gz CloudTrail files. Each file is either {"Records":[...]} (the
    standard CloudTrail delivery shape) or a bare list / JSON-lines. Never
    raises — unreadable/!JSON files are skipped."""
    import gzip
    files = []
    if os.path.isdir(path):
        for dp, _dn, fns in os.walk(path):
            for fn in fns:
                if fn.endswith(".json") or fn.endswith(".json.gz"):
                    files.append(os.path.join(dp, fn))
    elif os.path.isfile(path):
        files = [path]
    for fp in sorted(files):
        try:
            opener = gzip.open if fp.endswith(".gz") else open
            with opener(fp, "rt", errors="ignore") as f:
                raw = f.read()
        except OSError:
            continue
        try:
            obj = json.loads(raw)
            recs = obj.get("Records", obj) if isinstance(obj, dict) else obj
            if isinstance(recs, list):
                for r in recs:
                    if isinstance(r, dict):
                        yield r
                continue
        except ValueError:
            pass
        # Fall back to JSON-lines.
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                if isinstance(r, dict):
                    yield r
            except ValueError:
                continue


# Auth/console plumbing that shows up in every trail but isn't a real "service
# in use" signal — the sign-in/credential surfaces every account exercises.
# Dropped (like `iam` in code detection) to keep the results focused on the
# services an application actually uses.
_CLOUDTRAIL_NOISE = {"sts", "signin", "sso", "sso-oidc", "identitystore",
                     "health", "cloudtrail"}


def parse_cloudtrail(path):
    """Parse CloudTrail logs at `path` into Detections. Returns list[Detection].
    Only AwsApiCall events are used; management/console events are skipped. The
    evidence 'file' is the region (there is no source line); grounding maps the
    eventSource slug to the canonical service and validates the operation."""
    detections = []
    for r in _iter_cloudtrail_records(path):
        if r.get("eventType") and r.get("eventType") != "AwsApiCall":
            continue
        source = r.get("eventSource") or ""
        op = r.get("eventName") or ""
        region = r.get("awsRegion") or ""
        if not source or not op:
            continue
        svc = source.replace(".amazonaws.com", "")
        if svc in _CLOUDTRAIL_NOISE:
            continue
        # api op in Service+Op form; grounding canonicalizes + validates.
        detections.append(Detection(
            "api", f"{svc}+{op}", svc, f"cloudtrail:{region or 'unknown'}", 0,
            "cloudtrail", "high"))
        # service-axis too, so the services tab populates.
        detections.append(Detection(
            "service", svc, svc, f"cloudtrail:{region or 'unknown'}", 0,
            "cloudtrail", "high"))
    return detections


# --------------------------------------------------------------------------- #
# Java AWS SDK v2 parsing.
# --------------------------------------------------------------------------- #
# software.amazon.awssdk.services.<service>...  (v2, per-service) and the
# legacy com.amazonaws.services.<service>  (v1). Service segment is the signal.
_JAVA_V2_IMPORT_RE = re.compile(
    r"software\.amazon\.awssdk\.services\.([a-z0-9]+)")
_JAVA_V1_IMPORT_RE = re.compile(
    r"com\.amazonaws\.services\.([a-z0-9]+)")


def parse_java(text, rel_path):
    """Detect AWS services from Java SDK v2/v1 service imports (HIGH — a
    per-service import package is unambiguous). Java API-operation extraction
    (request/response class names) is deferred; service-level matches the bar
    for now and mirrors what the manifest axis provides elsewhere."""
    detections = []
    for line_num, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if not stripped.startswith("import"):
            continue
        for rx in (_JAVA_V2_IMPORT_RE, _JAVA_V1_IMPORT_RE):
            for m in rx.finditer(line):
                svc = m.group(1)
                if svc in ("core", "regions", "auth", "utils"):
                    continue
                detections.append(Detection(
                    "service", sdk_service_display(svc), svc, rel_path,
                    line_num, "sdk-java", "high"))
    return detections


# --------------------------------------------------------------------------- #
# Grounding against the authoritative AWS API universe.
#
# The bundled `aws-api-universe.json.gz` (generated from botocore's service
# models) is the source of truth for "what is a real AWS service / operation".
# Grounding does three things, deterministically:
#   1. resolve each detected service token to its canonical SdkServiceId
#      (exact serviceId match wins over endpointPrefix/signingName aliases, so
#      `s3` -> "S3", never "S3 Control"; `events` -> "EventBridge"),
#   2. DROP service detections that resolve to nothing (non-AWS / phantom hits),
#   3. DROP api operations that are not a real operation of their service
#      (kills heuristic false positives like a pandas `.read_csv()` misread as
#      `S3+ReadCsv`).
# CFN detections are kept as-is (the AWS::Service::Resource form is already
# authoritative and format-generic); their owning service is canonicalized when
# resolvable. If the universe file is missing, grounding degrades to the built-in
# canonicalization and drops nothing, so the detector still runs fully offline.
# --------------------------------------------------------------------------- #
_UNIVERSE = None
_UNIVERSE_SID_NORM = None       # norm(serviceId) -> canonical serviceId
_UNIVERSE_ALIAS = None          # norm(alias) -> canonical serviceId (unique only)
_UNIVERSE_OPS = None            # canonical serviceId -> set(lowercased op names)
_UNIVERSE_PREFIX = None         # canonical serviceId -> endpointPrefix (CloudTrail style)
_UNIVERSE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "aws-api-universe.json.gz")


def _uni_norm(token):
    """Normalize a service token for matching: lowercase, strip separators."""
    if not isinstance(token, str):
        return ""
    return token.lower().replace(" ", "").replace("-", "").replace("_", "")


def _load_universe():
    """Load + index the bundled universe once. Returns True when available."""
    global _UNIVERSE, _UNIVERSE_SID_NORM, _UNIVERSE_ALIAS, _UNIVERSE_OPS
    global _UNIVERSE_PREFIX
    if _UNIVERSE is not None:
        return bool(_UNIVERSE)
    try:
        import gzip
        with gzip.open(_UNIVERSE_FILE, "rt") as f:
            _UNIVERSE = json.load(f).get("services", {})
    except Exception:
        _UNIVERSE = {}
        return False
    _UNIVERSE_SID_NORM = {_uni_norm(sid): sid for sid in _UNIVERSE}
    _UNIVERSE_OPS = {sid: {o.lower() for o in v.get("ops", [])}
                     for sid, v in _UNIVERSE.items()}
    # SdkServiceId -> endpointPrefix (CloudTrail style). Older universe
    # files without the field yield "" (emit degrades to service-only).
    _UNIVERSE_PREFIX = {sid: v.get("endpointPrefix", "")
                        for sid, v in _UNIVERSE.items()}
    # Alias index: only keep aliases that resolve UNIQUELY (avoid s3/S3-Control
    # style collisions; exact serviceId match is handled separately and wins).
    alias_hits = {}
    for sid, v in _UNIVERSE.items():
        for a in v.get("aliases", []):
            alias_hits.setdefault(_uni_norm(a), set()).add(sid)
    _UNIVERSE_ALIAS = {a: next(iter(s)) for a, s in alias_hits.items()
                       if len(s) == 1}
    return True


def resolve_service_id(token):
    """Canonical SdkServiceId for a service token, or None when it is not a real
    AWS service. Exact serviceId match wins over aliases (so `s3` -> "S3")."""
    if not _load_universe():
        return None
    t = _uni_norm(token)
    if t in _UNIVERSE_SID_NORM:
        return _UNIVERSE_SID_NORM[t]
    return _UNIVERSE_ALIAS.get(t)


def _cfn_service_id(identifier):
    """SdkServiceId for a CFN type AWS::<Service>::<Type>, via its service seg."""
    segs = identifier.split("::")
    if len(segs) >= 2 and segs[0] == "AWS":
        return resolve_service_id(segs[1])
    return None


def ground_detections(detections):
    """Apply universe grounding to a detection list. See module comment above.
    When the universe is unavailable, falls back to the built-in canonicalization
    and drops nothing (fully offline-safe)."""
    if not _load_universe():
        for d in detections:
            d.service = canonical_service_id(d)
        return detections

    kept = []
    for d in detections:
        if d.axis == "service":
            sid = resolve_service_id(d.service or d.identifier)
            if sid:
                d.service = sid
                d.endpoint_prefix = _UNIVERSE_PREFIX.get(sid, "")
                kept.append(d)
            # else: not a real AWS service -> drop (phantom / internal client).
        elif d.axis == "api" and "+" in d.identifier:
            svc, op = d.identifier.split("+", 1)
            sid = resolve_service_id(svc)
            if sid and op.lower() in _UNIVERSE_OPS.get(sid, ()):
                d.service = sid
                d.endpoint_prefix = _UNIVERSE_PREFIX.get(sid, "")
                d.identifier = f"{sid.replace(' ', '')}+{op}"
                kept.append(d)
            # else: not a real operation of a real service -> drop.
        elif d.axis == "cfn":
            sid = _cfn_service_id(d.identifier)
            if sid:
                d.service = sid
                d.endpoint_prefix = _UNIVERSE_PREFIX.get(sid, "")
            kept.append(d)
        else:
            kept.append(d)
    return kept


# --------------------------------------------------------------------------- #
# File collection + dispatch.
# --------------------------------------------------------------------------- #
def collect_files(root):
    """Walk the workspace, returning classified file paths (absolute).

    Returns dict: cfn_synth[], cfn_sam[], terraform[], manifests[], sources[].
    cdk.out is walked (synth templates); other generated dirs pruned.
    """
    out = {"cfn_synth": [], "cfn_sam": [], "terraform": [],
           "manifests": [], "sources": [], "tfvars": []}
    for dirpath, dirnames, filenames in os.walk(root):
        base = os.path.basename(dirpath)
        # Prune skip dirs, but keep cdk.out.
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and not (d.startswith(".") and d not in (".",))]
        in_synth = SYNTH_DIR in dirpath.split(os.sep)
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            if os.path.abspath(full) in _SELF_FILES:
                continue  # never detect on the detector's own source (self-scan)
            if fn == ".capabilities-detector-registry.json" \
                    or fn.startswith("capabilities-report-") \
                    or fn.startswith("capabilities-payload-"):
                continue  # our own outputs written into the scanned dir
            ext = os.path.splitext(fn)[1].lower()
            if in_synth:
                if fn.endswith(".template.json") or fn.endswith(".template.yaml"):
                    out["cfn_synth"].append(full)
                continue
            if fn in CFN_SAM_NAMES:
                out["cfn_sam"].append(full)
            elif fn in MANIFEST_NAMES:
                out["manifests"].append(full)
            elif ext == ".tf":
                out["terraform"].append(full)
            elif fn.endswith(".tfvars") or fn.endswith(".tfvars.json"):
                out["tfvars"].append(full)
            elif ext in SOURCE_EXT:
                out["sources"].append(full)
            elif ext in (".yaml", ".yml", ".json"):
                # Could be a hand-written CFN template not named template.*;
                # cheap content probe added at read time.
                out["cfn_sam"].append(full)
    for k in out:
        out[k].sort()
    return out


def _read(full):
    """Read a file safely; returns text or None (too big / binary / unreadable)."""
    try:
        if os.path.getsize(full) > MAX_FILE_BYTES:
            return None
        with open(full, "r", errors="ignore") as f:
            return f.read()
    except OSError:
        return None


def _looks_like_cfn(text):
    return ('"Resources"' in text or re.search(r"^Resources\s*:", text, re.M)
            or "AWS::" in text)


def detect(root, cloudtrail_path=None):
    """Run all deterministic detectors over the workspace. Returns
    (deduped_detections_sorted, raw_count, files_summary).

    When `cloudtrail_path` is given, CloudTrail log detections (runtime "what
    actually ran" signal) are merged in alongside the static code scan and flow
    through the same grounding/dedupe pipeline. Pass root=None to run CloudTrail
    ONLY (no code scan)."""
    all_dets = []
    files = {"cfn_synth": [], "cfn_sam": [], "terraform": [],
             "manifests": [], "sources": []}

    if cloudtrail_path:
        all_dets += parse_cloudtrail(cloudtrail_path)

    if root is None:
        # CloudTrail-only mode.
        raw_count = len(all_dets)
        deduped = _dedupe(ground_detections(all_dets))
        return deduped, raw_count, {**{k: 0 for k in files}, "cloudtrail": 1}

    root = os.path.abspath(root)
    files = collect_files(root)

    def rel(full):
        return os.path.relpath(full, root)

    # Config/runtime property extraction is a two-phase flow so that variable
    # references can be resolved against values declared ANYWHERE in the repo:
    #   Phase A: parse resources (raw property values) + collect a repo-wide
    #            symbol table {name: set(literals)} from TF variable/locals
    #            defaults, TF *.tfvars constants, and CFN Parameters defaults.
    #   Phase B: resolve each raw value to the set of literals it could take
    #            (literal | ref->symbol | <unresolved>) and accumulate per type.
    # A bare ref with several repo values reports ALL of them — if the repo
    # declares both m5.large and m5.xlarge, both are reported (even if a given
    # value is only in unused/constants code). Deeper fidelity (exact deploy-time
    # value) comes from `cdk synth` / `terraform plan` (see README).
    symbols = {}            # name -> set(literal values) seen repo-wide
    raw_prop_entries = []   # (cfn_type, {attr: raw_value})

    def _add_symbols(d):
        for k, v in d.items():
            symbols.setdefault(k, set()).add(v)

    for full in files["cfn_synth"]:
        text = _read(full)
        if text:
            all_dets += parse_cfn_template(text, rel(full), is_synth=True)
            all_dets += parse_iam_actions(text, rel(full))
            _add_symbols(collect_cfn_parameter_defaults(text))
            for ct, _rp, props in extract_cfn_properties(text, rel(full), True):
                raw_prop_entries.append((ct, props))

    for full in files["cfn_sam"]:
        text = _read(full)
        if text and _looks_like_cfn(text):
            all_dets += parse_cfn_template(text, rel(full), is_synth=False)
            all_dets += parse_iam_actions(text, rel(full))
            _add_symbols(collect_cfn_parameter_defaults(text))
            for ct, _rp, props in extract_cfn_properties(text, rel(full), False):
                raw_prop_entries.append((ct, props))

    for full in files["terraform"]:
        text = _read(full)
        if text:
            all_dets += parse_terraform(text, rel(full))
            all_dets += parse_iam_actions(text, rel(full))
            _add_symbols(collect_tf_variable_defaults(text))
            for ct, _rp, props in extract_tf_properties(text, rel(full)):
                raw_prop_entries.append((ct, props))

    for full in files["tfvars"]:
        text = _read(full)
        if text:
            _add_symbols(collect_tfvars(text))

    # Phase B: resolve raw values against the completed symbol table.
    cfn_props = {}  # {cfn_type: {attr_name: set(resolved literals)}}
    for cfn_type, props in raw_prop_entries:
        bucket = cfn_props.setdefault(cfn_type, {})
        for attr, raw in props.items():
            bucket.setdefault(attr, set()).update(resolve_value(raw, symbols))

    for full in files["manifests"]:
        text = _read(full)
        if text:
            all_dets += parse_manifest(text, rel(full), os.path.basename(full))

    for full in files["sources"]:
        text = _read(full)
        if not text:
            continue
        ext = os.path.splitext(full)[1].lower()
        if ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
            all_dets += parse_cdk_imports(text, rel(full))
            all_dets += parse_ts_callsites(text, rel(full))
            all_dets += parse_iam_actions(text, rel(full))
        elif ext == ".py":
            all_dets += parse_py_callsites(text, rel(full))
            all_dets += parse_iam_actions(text, rel(full))
        elif ext == ".go":
            all_dets += parse_go_callsites(text, rel(full))
        elif ext == ".java":
            all_dets += parse_java(text, rel(full))
            all_dets += parse_java_callsites(text, rel(full))

    # Derive service-axis detections implied by CFN types, so the services
    # tab is populated even for pure-IaC repos with no SDK manifest.
    derived = []
    seen_services = {d.service for d in all_dets if d.axis == "service" and d.service}
    for d in all_dets:
        if d.axis == "cfn" and d.service and d.service.lower() not in \
                {s.lower() for s in seen_services}:
            derived.append(Detection(
                "service", sdk_service_display(d.service.lower()), d.service,
                d.file, d.line, "derived-from-cfn", d.confidence))
            seen_services.add(d.service)
    all_dets += derived

    raw_count = len(all_dets)
    # Ground every detection against the authoritative AWS API universe: resolve
    # each service to its canonical SdkServiceId, drop non-AWS services (phantom
    # matches), and drop api operations that are not real operations of their
    # service (kills heuristic false positives like pandas .read_csv -> S3.ReadCsv).
    grounded_dets = ground_detections(all_dets)
    deduped = _dedupe(grounded_dets)
    # Attach accumulated config/runtime properties to their cfn detection. The
    # cfn identifier is the fully-qualified type (AWS::Lambda::Function), so the
    # match is exact; property depth rides the resource it describes. When an
    # attribute has at least one resolved literal, drop the "<unresolved>"
    # marker for that attribute — the literal is the signal; the marker is only
    # meaningful when NOTHING resolved.
    if cfn_props:
        for d in deduped:
            if d.axis == "cfn" and d.identifier in cfn_props:
                attrs = {}
                for a, vs in cfn_props[d.identifier].items():
                    resolved = {v for v in vs if v != "<unresolved>"}
                    attrs[a] = resolved if resolved else {"<unresolved>"}
                d.attributes = attrs
    return deduped, raw_count, {k: len(v) for k, v in files.items()}


# Confidence ordering for keeping the strongest evidence on dedupe.
_CONF_RANK = {"high": 3, "medium": 2, "low": 1}


def _dedupe(detections):
    """Collapse to one Detection per (axis, identifier), keeping the highest-
    confidence detection as the survivor but ACCUMULATING every distinct
    file:line onto it (evidence_locations), so a capability found across several
    packages shows all its locations instead of just the first hit. Deterministic
    order: axis, then identifier; locations sorted for stable output."""
    best = {}
    locations = {}  # key -> ordered unique list of file:line strings
    for d in detections:
        k = d.key()
        loc = d._one_location()
        seen = locations.setdefault(k, [])
        if loc not in seen:
            seen.append(loc)
        cur = best.get(k)
        if cur is None or _CONF_RANK.get(d.confidence, 0) > _CONF_RANK.get(cur.confidence, 0):
            best[k] = d
    for k, d in best.items():
        d.evidence_locations = sorted(locations[k])
    axis_order = {"service": 0, "cfn": 1, "api": 2}
    return sorted(best.values(),
                  key=lambda d: (axis_order.get(d.axis, 9), d.identifier.lower()))


# --------------------------------------------------------------------------- #
# CSV + table rendering.
# --------------------------------------------------------------------------- #
def to_csv(detections, path):
    import csv
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["axis", "identifier", "service", "serviceEndpointPrefix",
                    "file", "line", "detectionMethod"])
        for d in detections:
            w.writerow([d.axis, d.identifier, d.service, d.endpoint_prefix,
                        d.file, d.line, d.method])


def print_table(detections, files_summary):
    by_axis = defaultdict(list)
    for d in detections:
        by_axis[d.axis].append(d)
    labels = {"service": "SERVICES", "cfn": "CLOUDFORMATION RESOURCE TYPES",
              "api": "API OPERATIONS"}
    print()
    for axis in ("service", "cfn", "api"):
        items = by_axis.get(axis, [])
        if not items:
            continue
        print(f"== {labels[axis]} ({len(items)}) ==")
        width = max((len(d.identifier) for d in items), default=0)
        for d in items:
            print(f"  {d.identifier.ljust(width)}  "
                  f"{d.method:<20} {d.evidence()}")
        print()
    total = len(detections)
    print(f"Detected {total} unique capabilities "
          f"({len(by_axis['service'])} services, {len(by_axis['cfn'])} CFN types, "
          f"{len(by_axis['api'])} API operations) across "
          f"{files_summary.get('cfn_synth', 0)} synth + "
          f"{files_summary.get('cfn_sam', 0)} template + "
          f"{files_summary.get('terraform', 0)} tf + "
          f"{files_summary.get('manifests', 0)} manifest files.")


# --------------------------------------------------------------------------- #
# Report generation (Markdown + HTML).
# --------------------------------------------------------------------------- #
def _run_id():
    """A unique, sortable run id: UTC timestamp + short random suffix, e.g.
    20260708T174233Z-a3f9. Sortable by time; suffix avoids collisions on
    same-second runs."""
    import datetime
    import secrets
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{secrets.token_hex(2)}"


_AXIS_LABEL = {"service": "Services", "cfn": "CloudFormation Resource Types",
               "api": "API Operations"}
_AXIS_ORDER = ("service", "cfn", "api")


def _group_by_axis(detections):
    by_axis = defaultdict(list)
    for d in detections:
        by_axis[d.axis].append(d)
    return by_axis


def _format_attributes(det):
    """Compact one-line rendering of a detection's config/runtime properties,
    e.g. `runtime=java17; engineVersion=15.4, 15.7`. Empty string when none."""
    if not det.attributes:
        return ""
    parts = []
    for attr in sorted(det.attributes):
        vals = ", ".join(sorted(str(v) for v in det.attributes[attr]))
        parts.append(f"{attr}={vals}")
    return "; ".join(parts)


def render_markdown(detections, files_summary, target_path, run_id):
    """Render the detection report as Markdown — a deterministic inventory of the
    services / CFN resource types / API operations the code uses."""
    by_axis = _group_by_axis(detections)
    lines = []
    lines.append(f"# AWS Capabilities Detection Report")
    lines.append("")
    lines.append(f"- **Target:** `{target_path}`")
    lines.append(f"- **Run ID:** `{run_id}`")
    lines.append(f"- **Detected:** {len(by_axis['service'])} services, "
                 f"{len(by_axis['cfn'])} CloudFormation resource types, "
                 f"{len(by_axis['api'])} API operations")
    lines.append(f"- **Scanned:** {files_summary.get('cfn_synth', 0)} synth + "
                 f"{files_summary.get('cfn_sam', 0)} template + "
                 f"{files_summary.get('terraform', 0)} terraform + "
                 f"{files_summary.get('manifests', 0)} manifest files")
    lines.append("")
    for axis in _AXIS_ORDER:
        items = by_axis.get(axis, [])
        if not items:
            continue
        lines.append(f"## {_AXIS_LABEL[axis]} ({len(items)})")
        lines.append("")
        # The Config column only carries signal on the cfn axis (property
        # extraction targets resource types); show it there, keep others lean.
        if axis == "cfn":
            lines.append("| Identifier | Service | Config | Detected via | Evidence |")
            lines.append("|---|---|---|---|---|")
            for d in items:
                cfg = _format_attributes(d)
                lines.append(f"| `{d.identifier}` | {d.service or '—'} | "
                             f"{('`' + cfg + '`') if cfg else '—'} | "
                             f"{d.method} | `{d.evidence()}` |")
        else:
            lines.append("| Identifier | Service | Detected via | Evidence |")
            lines.append("|---|---|---|---|")
            for d in items:
                lines.append(f"| `{d.identifier}` | {d.service or '—'} | "
                             f"{d.method} | `{d.evidence()}` |")
        lines.append("")
    return "\n".join(lines) + "\n"


def render_html(detections, files_summary, target_path, run_id):
    """Render the detection report as a self-contained, styled HTML page (no
    external CSS/JS)."""
    import html as _html
    by_axis = _group_by_axis(detections)

    def esc(s):
        return _html.escape(str(s))

    parts = []
    parts.append(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capabilities Detection — {esc(run_id)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 2rem; background: #fff; color: #1a1a1a; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #0d1117; color: #e6edf3; }}
    .card {{ background:#161b22 !important; border-color:#30363d !important; }}
    th {{ background:#21262d !important; }} tr:nth-child(even) td {{ background:#12171e !important; }}
    code {{ background:#21262d !important; }} }}
  h1 {{ font-size: 1.6rem; margin: 0 0 .25rem; }}
  h2 {{ font-size: 1.15rem; margin: 2rem 0 .5rem; }}
  .meta {{ color:#57606a; margin-bottom:1rem; }}
  .cards {{ display:flex; gap:1rem; flex-wrap:wrap; margin:1rem 0 1.5rem; }}
  .card {{ border:1px solid #d0d7de; border-radius:10px; padding:1rem 1.25rem; background:#f6f8fa; min-width:150px; }}
  .card .n {{ font-size:2rem; font-weight:700; }}
  .card .l {{ color:#57606a; font-size:.85rem; text-transform:uppercase; letter-spacing:.04em; }}
  .note {{ border-left:4px solid #d29922; background:rgba(210,153,34,.08); padding:.75rem 1rem; border-radius:0 8px 8px 0; margin:1rem 0; }}
  table {{ border-collapse:collapse; width:100%; margin:.5rem 0 1.5rem; font-size:13px; }}
  th,td {{ text-align:left; padding:.45rem .7rem; border-bottom:1px solid #d0d7de; }}
  th {{ background:#f6f8fa; font-weight:600; }}
  code {{ background:#eff1f3; padding:.1rem .35rem; border-radius:5px; font-size:12px; }}
  .pill {{ font-weight:600; }}
</style></head><body>""")
    parts.append(f"<h1>AWS Capabilities Detection Report</h1>")
    parts.append(f'<div class="meta">Target <code>{esc(target_path)}</code> '
                 f'&middot; Run <code>{esc(run_id)}</code></div>')
    parts.append('<div class="cards">')
    for axis in _AXIS_ORDER:
        parts.append(f'<div class="card"><div class="n">{len(by_axis.get(axis, []))}</div>'
                     f'<div class="l">{esc(_AXIS_LABEL[axis])}</div></div>')
    parts.append('</div>')

    for axis in _AXIS_ORDER:
        items = by_axis.get(axis, [])
        if not items:
            continue
        parts.append(f"<h2>{esc(_AXIS_LABEL[axis])} ({len(items)})</h2>")
        # Config column carries property depth on the cfn axis only.
        if axis == "cfn":
            parts.append("<table><thead><tr><th>Identifier</th><th>Service</th>"
                         "<th>Config</th><th>Detected via</th>"
                         "<th>Evidence</th></tr></thead><tbody>")
            for d in items:
                cfg = _format_attributes(d)
                parts.append(
                    f"<tr><td><code>{esc(d.identifier)}</code></td>"
                    f"<td>{esc(d.service or '—')}</td>"
                    f"<td>{('<code>' + esc(cfg) + '</code>') if cfg else '—'}</td>"
                    f"<td>{esc(d.method)}</td>"
                    f"<td><code>{esc(d.evidence())}</code></td></tr>")
        else:
            parts.append("<table><thead><tr><th>Identifier</th><th>Service</th>"
                         "<th>Detected via</th>"
                         "<th>Evidence</th></tr></thead><tbody>")
            for d in items:
                parts.append(
                    f"<tr><td><code>{esc(d.identifier)}</code></td>"
                    f"<td>{esc(d.service or '—')}</td>"
                    f"<td>{esc(d.method)}</td>"
                    f"<td><code>{esc(d.evidence())}</code></td></tr>")
        parts.append("</tbody></table>")
    parts.append("</body></html>")
    return "\n".join(parts) + "\n"


def write_reports(detections, files_summary, target_path, out_dir, run_id):
    """Write <out_dir>/capabilities-report-<run_id>.{md,html,json}. Returns the
    dict of written paths."""
    base = f"capabilities-report-{run_id}"
    paths = {
        "md": os.path.join(out_dir, base + ".md"),
        "html": os.path.join(out_dir, base + ".html"),
        "json": os.path.join(out_dir, base + ".json"),
    }
    with open(paths["md"], "w") as f:
        f.write(render_markdown(detections, files_summary, target_path, run_id))
    with open(paths["html"], "w") as f:
        f.write(render_html(detections, files_summary, target_path, run_id))
    with open(paths["json"], "w") as f:
        json.dump({
            "runId": run_id,
            "target": target_path,
            "filesSummary": files_summary,
            "detections": [d.to_dict() for d in detections],
        }, f, indent=2)
    return paths


# --------------------------------------------------------------------------- #
# Results payload — build the structured detection list and write it locally.
#
# This tool is fully STATIC and OFFLINE: it never makes a network call. It writes
# the results (report + a structured payload) to local files; sharing those files
# is up to the user (see _print_manual_delivery_notice).
#
# Each detection carries the core fields plus `service`; per-resource config depth
# (runtime, engineVersion, instanceType, ...) rides in `attributes`. No source
# code or file contents are ever included in the payload.
DETECTION_SOURCE = "DETECTOR"
SCHEMA_VERSION = "2"
RUN_TYPE = "PREFLIGHT"


def _detection_id(scan_id, axis, service, name, region=None):
    """Deterministic idempotency key: short sha256. A consumer can dedupe
    re-submissions of the same detection on this stable id."""
    import hashlib
    raw = f"{scan_id}|{DETECTION_SOURCE}|{axis}|{service}|{name}|{region or ''}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _wire_name(d):
    """The `name` a detection record carries, kept as a LEAF so service and the
    operation/resource-type stay in SEPARATE fields (service + name), NOT a
    combined `Service+Op` string. This lets a consumer join directly on
    `service` + `name` with no string-splitting.

      * api     -> bare operation      ("S3+PutObject"        -> "PutObject")
      * cfn     -> resource type name  ("AWS::S3::Bucket", unchanged)
      * service -> canonical service   (CloudTrail's raw "apigateway" -> the
                   grounded SdkServiceId, so every source looks the same)

    The internal `d.identifier` (the combined form) is left untouched — it stays
    the stable dedup / detectionId key."""
    if d.axis == "api" and "+" in d.identifier:
        return d.identifier.split("+", 1)[1]
    if d.axis == "service":
        return d.service or d.identifier
    return d.identifier


def build_detections(detections, customer, application, scan_id, timestamp,
                     regions=None):
    """Build the DETECTOR detection-record list for the results payload.

    Region policy:
      * DEFAULT (regions is empty/None) — emit ONE region-less record per
        detection. `region` is optional; when absent a consumer may fan the
        record out across the customer's preferred regions (one enriched row per
        region). This keeps region policy on the consumer and is the default.
      * EXPLICIT (regions given, e.g. from a positional region arg) — emit one
        record per (detection x region) tagged with that region, for a customer
        who wants to preflight specific regions themselves.

    Emits only what the detector knows: the core fields plus `service`
    (canonical SdkServiceId) and an `attributes` block carrying the detector's own
    detectionKind and serviceEndpointPrefix on the open seam. Both extension
    signals live in `attributes` (an open Document) rather than as top-level
    fields, so a consumer can ignore unknown keys. What the payload contains
    mirrors what the report displays."""
    region_list = regions if regions else [None]
    records = []
    for d in detections:
        for region in region_list:
            rec = {
                "schemaVersion": SCHEMA_VERSION,
                "detectionSource": DETECTION_SOURCE,
                "detectionId": _detection_id(scan_id, d.axis, d.service,
                                             d.identifier, region),
                "scanId": scan_id,
                "timestamp": timestamp,
                "customer": customer,
                "application": application,
                "runType": RUN_TYPE,
                "axis": d.axis,
                "name": _wire_name(d),
                "attributes": {
                    "detectionKind": d.method,
                },
            }
            if region:
                rec["region"] = region
            # Always carry the canonical service when known — including on the
            # service axis — so every source (repo scan, CloudTrail) presents the
            # same join key.
            if d.service:
                rec["service"] = d.service
            # Emit the CloudTrail-style endpoint prefix alongside the
            # SdkServiceId so a consumer can join on whichever it uses
            # (sdkServiceId or sdkEndpointPrefix) without translation. It goes in
            # the open `attributes` block rather than as a top-level field, so a
            # consumer that only knows the core fields can ignore it.
            if d.endpoint_prefix:
                rec["attributes"]["serviceEndpointPrefix"] = d.endpoint_prefix
            # Forward extracted config/runtime properties (runtime, instanceType,
            # engineVersion, wildcardActions...) into the same open `attributes`
            # block so a consumer receives the property depth, not just presence.
            # Each value is the sorted list of observed literals (may include the
            # "<unresolved>" sentinel when no literal resolved).
            if d.attributes:
                for attr_name, attr_vals in d.attributes.items():
                    rec["attributes"][attr_name] = sorted(attr_vals)
            records.append(rec)
    # Deterministic order: (region, axis, name, service).
    records.sort(key=lambda r: (r.get("region", ""), r["axis"], r["name"],
                                r.get("service", "")))
    return records


def write_payload(records, out_dir, run_id):
    """Write the structured results payload locally. This is the file the customer
    hands to their AWS point of contact for ingestion (no automated upload).
    Returns the path."""
    path = os.path.join(out_dir, f"capabilities-payload-{run_id}.json")
    with open(path, "w") as f:
        json.dump({"detections": records}, f, indent=2)
    return path


# --------------------------------------------------------------------------- #
# Identity registry: remember customer/application per scanned target so a
# re-run confirms (with option to edit) instead of asking cold.
# --------------------------------------------------------------------------- #
def _registry_path(out_dir):
    """State lives in the output dir (default: the current directory) — the same
    place reports are written. Deliberately NOT `~/.config` or any system dir:
    that keeps the tool's only filesystem requirement "write where you ran me",
    so it works for customers with the most locked-down permissions."""
    return os.path.join(out_dir, ".capabilities-detector-registry.json")


def _registry_key(args):
    """Absolute path of the scanned target — repo dir, or CloudTrail source in
    logs-only mode — used as the stable key for saved identity."""
    src = args.cloudtrail if args.path == "-" else args.path
    return os.path.abspath(src)


def load_identity(args, out_dir):
    """Return {'customer','application'} saved for this target, or None."""
    try:
        with open(_registry_path(out_dir)) as f:
            reg = json.load(f)
    except (OSError, ValueError):
        return None
    entry = reg.get(_registry_key(args))
    if isinstance(entry, dict) and entry.get("customer"):
        return {"customer": entry["customer"],
                "application": entry.get("application", "")}
    return None


def save_identity(args, out_dir, customer, application, timestamp):
    """Persist customer/application for this target. Best-effort; never fatal."""
    path = _registry_path(out_dir)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        try:
            with open(path) as f:
                reg = json.load(f)
            if not isinstance(reg, dict):
                reg = {}
        except (OSError, ValueError):
            reg = {}
        reg[_registry_key(args)] = {
            "customer": customer,
            "application": application,
            "lastRun": timestamp,
        }
        with open(path, "w") as f:
            json.dump(reg, f, indent=2, sort_keys=True)
    except OSError:
        pass  # a non-writable config dir must never break a scan


def _print_manual_delivery_notice(out_dir, run_id, payload_path, error=None):
    """The scan is fully local/offline; this notice points the user at the
    results file they can review and share with their AWS point of contact."""
    print("\n" + "=" * 70)
    print("  RESULTS READY — one quick step to share them")
    print("=" * 70)
    print("  Your scan completed and all results are saved locally.")
    print("\n  To share these results with the AWS team, review and then send")
    print("  the following file to your AWS point of contact:\n")
    print(f"    • {os.path.abspath(payload_path)}")
    print("\n  It contains only the detected AWS capability inventory (services,")
    print("  resource types, API operations, and their config such as runtimes")
    print("  and instance types) — no source code or file contents. Please")
    print("  review it before sending.")
    print("=" * 70)


def write_results_payload(detections, out_dir, run_id, args):
    """Collect the run's identity (customer/application), write the results
    payload locally, and print the hand-off notice. Fully offline — no network
    call, no credentials. Interactive runs ask for customer/application;
    non-interactive uses --customer."""
    import datetime

    interactive = sys.stdin.isatty()
    # App-name default: the scanned dir, or the CloudTrail source in logs-only mode.
    app_src = args.cloudtrail if args.path == "-" else args.path
    default_app = os.path.basename(os.path.abspath(app_src)).strip() or "unknown"

    # Flags always win. Otherwise, if we've scanned this target before, offer the
    # saved identity for confirm-or-edit instead of asking cold.
    saved = None if (args.customer or args.application) else load_identity(args, out_dir)

    customer = (args.customer or "").strip()
    application = (args.application or "").strip()

    if saved and interactive and not (customer and application):
        s_cust = saved["customer"]
        s_app = saved.get("application") or default_app
        print(f"\nFound saved identity for this target:")
        print(f"  Customer:    {s_cust}")
        print(f"  Application: {s_app}")
        try:
            choice = input("Use these? [Y=keep / e=edit / n=skip]: ").strip().lower()
        except EOFError:
            choice = ""
        if choice in ("", "y", "yes"):
            customer, application = s_cust, s_app
        elif choice in ("n", "no", "skip"):
            print("\nResults payload skipped (no identity). The detection report "
                  "was still written.", file=sys.stderr)
            return
        # else: edit — fall through to the field prompts, which default to the
        # saved values (press enter to keep, type to change).

    # --- 1. Customer (used to tag the results) ---
    if not customer and interactive:
        try:
            prompt = ("Customer / partner name (required): " if not saved
                      else f"Customer / partner name [{saved['customer']}]: ")
            entered = input(prompt).strip()
            customer = entered or (saved["customer"] if saved else "")
        except EOFError:
            customer = ""
    if not customer:
        print("\nResults payload skipped: no customer name provided "
              "(pass --customer \"<name>\"). The detection report was still written.",
              file=sys.stderr)
        return

    # --- 2. Application (defaults to the scanned dir; confirm/override live) ---
    if not application and interactive:
        app_default = (saved.get("application") if saved else "") or default_app
        try:
            entered = input(f"Application name [{app_default}]: ").strip()
            application = entered or app_default
        except EOFError:
            application = app_default
    if not application:
        application = (saved.get("application") if saved else "") or default_app

    # --- 3. Regions (optional: region-less by default, backend fans out) ---
    regions = ([r.strip() for r in args.regions.split(",") if r.strip()]
               if args.regions else [])

    scan_id = run_id
    timestamp = datetime.datetime.now().astimezone().isoformat()
    # Remember identity for this target so a re-run confirms instead of asking
    # cold. Skipped for non-interactive one-off flag runs.
    if interactive:
        save_identity(args, out_dir, customer, application, timestamp)
    records = build_detections(detections, customer, application, scan_id,
                               timestamp, regions=regions)
    payload_path = write_payload(records, out_dir, run_id)

    region_note = (f"tagged for {', '.join(regions)}" if regions else "region-less")
    print(f"\nResults payload: {len(records)} detection(s) ({region_note})")
    print(f"  Customer:    {customer}")
    print(f"  Application: {application}")

    # This tool is fully static/offline — it never uploads. Point the customer at
    # the payload to hand back to their AWS contact for ingestion.
    _print_manual_delivery_notice(out_dir, run_id, payload_path)


# --------------------------------------------------------------------------- #
# CLI.
# --------------------------------------------------------------------------- #
def _parse_args(argv):
    p = argparse.ArgumentParser(
        description="Deterministically detect AWS service / CFN / API "
                    "dependencies in a codebase.")
    p.add_argument("path", nargs="?", default=".",
                   help="workspace path to scan (default: current directory)")
    p.add_argument("--csv", default=None, help="write detections to this CSV path")
    p.add_argument("--json", default=None, help="write detections to this JSON path")
    p.add_argument("--out-dir", default=".",
                   help="directory to write the per-run report into "
                        "(default: current directory)")
    p.add_argument("--no-report", action="store_true",
                   help="skip writing the MD/HTML/JSON report files")
    p.add_argument("--cloudtrail", default=None, metavar="PATH",
                   help="also parse CloudTrail logs (a .json/.json.gz file or a "
                        "directory of them) for runtime 'what actually ran' "
                        "signal. Combine with a repo path, or use '--cloudtrail "
                        "PATH -' style with path '-' to parse logs only.")
    p.add_argument("--quiet", action="store_true", help="suppress the table")
    # Results payload. The tool is fully offline — it writes a local results
    # payload and prints how to hand it to an AWS contact. It never uploads.
    p.add_argument("--no-payload", dest="no_payload",
                   action="store_true",
                   help="detection/report only — skip writing the results payload")
    p.add_argument("--customer", default=None,
                   help="customer/partner name to tag the results with "
                        "(prompted if omitted in an interactive run)")
    p.add_argument("--application", default=None,
                   help="application name to tag the results with "
                        "(default/prompt: the scanned directory name)")
    p.add_argument("--regions", default=None,
                   help="comma-separated regions to tag results with, e.g. "
                        "ap-southeast-6 (default: region-less)")
    return p.parse_args(argv)


def main(argv):
    args = _parse_args(argv[1:])
    # CloudTrail-only mode: path given as "-" means don't scan a repo, just logs.
    cloudtrail_only = args.cloudtrail and args.path == "-"
    if not cloudtrail_only and not os.path.isdir(args.path):
        print(f"Error: {args.path} is not a directory", file=sys.stderr)
        return 2
    if args.cloudtrail and not os.path.exists(args.cloudtrail):
        print(f"Error: --cloudtrail path {args.cloudtrail} does not exist",
              file=sys.stderr)
        return 2

    scan_root = None if cloudtrail_only else args.path
    detections, raw_count, files_summary = detect(
        scan_root, cloudtrail_path=args.cloudtrail)

    if args.csv:
        to_csv(detections, args.csv)
        print(f"Wrote {len(detections)} detections to {args.csv}", file=sys.stderr)
    if args.json:
        with open(args.json, "w") as f:
            json.dump([d.to_dict() for d in detections], f, indent=2)
        print(f"Wrote {len(detections)} detections to {args.json}", file=sys.stderr)

    if not args.quiet:
        print_table(detections, files_summary)

    run_id = _run_id()
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    if not args.no_report:
        target_label = (f"cloudtrail:{args.cloudtrail}" if cloudtrail_only
                        else os.path.abspath(args.path))
        paths = write_reports(detections, files_summary,
                              target_label, out_dir, run_id)
        print(f"\nReport written:")
        print(f"  HTML: {paths['html']}")
        print(f"  MD:   {paths['md']}")
        print(f"  JSON: {paths['json']}")

    # Results payload + hand-off notice. Written by default; skip with
    # --no-payload. Fully local — nothing is uploaded.
    if not args.no_payload:
        write_results_payload(detections, out_dir, run_id, args)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
