//! Public platform contract references and compatibility judgment.
//!
//! Provider evidence is exact `{ id, version }`; consumer intent is
//! `{ id, range }`. Contract ids never embed a version. The SemVer grammar,
//! limits, range subset, precedence and prerelease rule mirror
//! `packages/plugin-spec/src/{contracts,semver}.ts` exactly so Rust hosts and
//! TypeScript manifests make the same fail-closed decision.

use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_SEMVER_LENGTH: usize = 256;
pub const MAX_UNIT_DEPENDENCY_RANGE_LENGTH: usize = 512;
pub const MAX_UNIT_DEPENDENCY_CLAUSES: usize = 16;

/// Exact provider evidence. Private fields preserve the validated invariant;
/// the serialized wire remains exactly `{ "id", "version" }`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContractProviderRef {
    id: String,
    version: String,
}

impl ContractProviderRef {
    pub fn new(id: impl Into<String>, version: impl Into<String>) -> Result<Self, String> {
        let value = Self {
            id: id.into(),
            version: version.into(),
        };
        if !is_contract_id(&value.id) {
            return Err("contract provider id must be a version-free public contract id".into());
        }
        if !is_strict_semver(&value.version) {
            return Err("contract provider version must be strict SemVer".into());
        }
        Ok(value)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn version(&self) -> &str {
        &self.version
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawContractProviderRef {
    id: String,
    version: String,
}

impl<'de> Deserialize<'de> for ContractProviderRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawContractProviderRef::deserialize(deserializer)?;
        Self::new(raw.id, raw.version).map_err(serde::de::Error::custom)
    }
}

/// Consumer compatibility requirement. Private fields preserve the validated
/// invariant; the serialized wire remains exactly `{ "id", "range" }`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContractRequirement {
    id: String,
    range: String,
}

impl ContractRequirement {
    pub fn new(id: impl Into<String>, range: impl Into<String>) -> Result<Self, String> {
        let value = Self {
            id: id.into(),
            range: range.into(),
        };
        if !is_contract_id(&value.id) {
            return Err("contract requirement id must be a version-free public contract id".into());
        }
        if !is_unit_dependency_range(&value.range) {
            return Err("contract requirement range must use the supported SemVer subset".into());
        }
        Ok(value)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn range(&self) -> &str {
        &self.range
    }

    pub fn matches(&self, provider: &ContractProviderRef) -> bool {
        self.id == provider.id && semver_satisfies(&provider.version, &self.range) == Some(true)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawContractRequirement {
    id: String,
    range: String,
}

impl<'de> Deserialize<'de> for ContractRequirement {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawContractRequirement::deserialize(deserializer)?;
        Self::new(raw.id, raw.range).map_err(serde::de::Error::custom)
    }
}

pub fn is_contract_id(value: &str) -> bool {
    ["soksak-spec-sidecar-", "soksak-spec-plugin-"]
        .iter()
        .any(|prefix| value.strip_prefix(prefix).is_some_and(is_contract_name))
        || value == "soksak-spec-service"
        || value
            .strip_prefix("soksak-spec-service-")
            .is_some_and(is_contract_name)
}

pub fn is_sidecar_contract_id(value: &str) -> bool {
    value
        .strip_prefix("soksak-spec-sidecar-")
        .is_some_and(is_contract_name)
}

pub fn is_service_contract_id(value: &str) -> bool {
    value == "soksak-spec-service"
        || value
            .strip_prefix("soksak-spec-service-")
            .is_some_and(is_contract_name)
}

fn is_contract_name(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[derive(Debug, Clone)]
struct ParsedSemver {
    core: [String; 3],
    prerelease: Option<Vec<String>>,
}

fn valid_numeric(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_prerelease_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && (!value.bytes().all(|byte| byte.is_ascii_digit()) || valid_numeric(value))
}

fn valid_build_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn parse_semver(value: &str) -> Option<ParsedSemver> {
    if value.is_empty() || value.len() > MAX_SEMVER_LENGTH || !value.is_ascii() {
        return None;
    }
    let (without_build, build) = match value.split_once('+') {
        Some((left, right)) if !right.contains('+') => (left, Some(right)),
        Some(_) => return None,
        None => (value, None),
    };
    if build.is_some_and(|raw| raw.split('.').any(|part| !valid_build_identifier(part))) {
        return None;
    }
    let (core_raw, prerelease) = match without_build.split_once('-') {
        Some((left, right)) => {
            let parts = right.split('.').map(str::to_owned).collect::<Vec<_>>();
            if parts.iter().any(|part| !valid_prerelease_identifier(part)) {
                return None;
            }
            (left, Some(parts))
        }
        None => (without_build, None),
    };
    let core = core_raw.split('.').collect::<Vec<_>>();
    if core.len() != 3 || core.iter().any(|part| !valid_numeric(part)) {
        return None;
    }
    Some(ParsedSemver {
        core: [core[0].to_owned(), core[1].to_owned(), core[2].to_owned()],
        prerelease,
    })
}

pub fn is_strict_semver(value: &str) -> bool {
    parse_semver(value).is_some()
}

#[derive(Debug, Clone, Copy)]
enum RangeOperator {
    Caret,
    Tilde,
    Gte,
    Lte,
    Gt,
    Lt,
    Eq,
}

fn range_clause(value: &str) -> Option<(RangeOperator, &str)> {
    for (prefix, operator) in [
        (">=", RangeOperator::Gte),
        ("<=", RangeOperator::Lte),
        ("^", RangeOperator::Caret),
        ("~", RangeOperator::Tilde),
        (">", RangeOperator::Gt),
        ("<", RangeOperator::Lt),
        ("=", RangeOperator::Eq),
    ] {
        if let Some(boundary) = value.strip_prefix(prefix) {
            return Some((operator, boundary));
        }
    }
    Some((RangeOperator::Eq, value))
}

pub fn is_unit_dependency_range(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_UNIT_DEPENDENCY_RANGE_LENGTH
        || value.trim() != value
        || value.contains("||")
    {
        return false;
    }
    if value == "*" {
        return true;
    }
    let clauses = value.split(' ').collect::<Vec<_>>();
    !clauses.is_empty()
        && clauses.len() <= MAX_UNIT_DEPENDENCY_CLAUSES
        && clauses.iter().all(|clause| {
            !clause.is_empty()
                && *clause != "*"
                && range_clause(clause).is_some_and(|(_, boundary)| is_strict_semver(boundary))
        })
}

fn numeric_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn prerelease_identifier_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let left_numeric = left.bytes().all(|byte| byte.is_ascii_digit());
    let right_numeric = right.bytes().all(|byte| byte.is_ascii_digit());
    match (left_numeric, right_numeric) {
        (true, true) => numeric_cmp(left, right),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => left.cmp(right),
    }
}

fn parsed_semver_cmp(left: &ParsedSemver, right: &ParsedSemver) -> std::cmp::Ordering {
    for index in 0..3 {
        let compared = numeric_cmp(&left.core[index], &right.core[index]);
        if compared != std::cmp::Ordering::Equal {
            return compared;
        }
    }
    match (&left.prerelease, &right.prerelease) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left_parts), Some(right_parts)) => {
            for index in 0..left_parts.len().max(right_parts.len()) {
                match (left_parts.get(index), right_parts.get(index)) {
                    (Some(left_part), Some(right_part)) => {
                        let compared = prerelease_identifier_cmp(left_part, right_part);
                        if compared != std::cmp::Ordering::Equal {
                            return compared;
                        }
                    }
                    (None, Some(_)) => return std::cmp::Ordering::Less,
                    (Some(_), None) => return std::cmp::Ordering::Greater,
                    (None, None) => break,
                }
            }
            std::cmp::Ordering::Equal
        }
    }
}

fn increment_decimal(value: &str) -> String {
    let mut bytes = value.as_bytes().to_vec();
    for index in (0..bytes.len()).rev() {
        if bytes[index] < b'9' {
            bytes[index] += 1;
            return String::from_utf8(bytes).expect("decimal is ASCII");
        }
        bytes[index] = b'0';
    }
    let mut out = Vec::with_capacity(bytes.len() + 1);
    out.push(b'1');
    out.extend(bytes);
    String::from_utf8(out).expect("decimal is ASCII")
}

fn upper_bound(base: &ParsedSemver, operator: RangeOperator) -> ParsedSemver {
    let mut core = base.core.clone();
    match operator {
        RangeOperator::Tilde => {
            core[1] = increment_decimal(&core[1]);
            core[2] = "0".into();
        }
        RangeOperator::Caret if core[0] != "0" => {
            core[0] = increment_decimal(&core[0]);
            core[1] = "0".into();
            core[2] = "0".into();
        }
        RangeOperator::Caret if core[1] != "0" => {
            core[1] = increment_decimal(&core[1]);
            core[2] = "0".into();
        }
        RangeOperator::Caret => core[2] = increment_decimal(&core[2]),
        _ => unreachable!("upper_bound only receives caret or tilde"),
    }
    ParsedSemver {
        core,
        prerelease: None,
    }
}

fn clause_satisfied(version: &ParsedSemver, clause: &str) -> Option<bool> {
    let (operator, boundary_raw) = range_clause(clause)?;
    let boundary = parse_semver(boundary_raw)?;
    let compared = parsed_semver_cmp(version, &boundary);
    Some(match operator {
        RangeOperator::Caret | RangeOperator::Tilde => {
            compared != std::cmp::Ordering::Less
                && parsed_semver_cmp(version, &upper_bound(&boundary, operator))
                    == std::cmp::Ordering::Less
        }
        RangeOperator::Gte => compared != std::cmp::Ordering::Less,
        RangeOperator::Lte => compared != std::cmp::Ordering::Greater,
        RangeOperator::Gt => compared == std::cmp::Ordering::Greater,
        RangeOperator::Lt => compared == std::cmp::Ordering::Less,
        RangeOperator::Eq => compared == std::cmp::Ordering::Equal,
    })
}

fn clause_names_same_core_prerelease(version: &ParsedSemver, clause: &str) -> bool {
    let Some((_, boundary_raw)) = range_clause(clause) else {
        return false;
    };
    let Some(boundary) = parse_semver(boundary_raw) else {
        return false;
    };
    boundary.prerelease.is_some() && boundary.core == version.core
}

/// Exact mirror of the TypeScript deterministic range subset. Invalid inputs
/// return `None`; callers must never turn malformed syntax into a match.
pub fn semver_satisfies(version: &str, range: &str) -> Option<bool> {
    let parsed = parse_semver(version)?;
    if !is_unit_dependency_range(range) {
        return None;
    }
    if range == "*" {
        return Some(parsed.prerelease.is_none());
    }
    let clauses = range.split(' ').collect::<Vec<_>>();
    let mut result = true;
    for clause in &clauses {
        result &= clause_satisfied(&parsed, clause)?;
    }
    if result
        && parsed.prerelease.is_some()
        && !clauses
            .iter()
            .any(|clause| clause_names_same_core_prerelease(&parsed, clause))
    {
        result = false;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_refs_are_canonical_objects_and_legacy_strings_are_rejected() {
        let provider = ContractProviderRef::new("soksak-spec-service", "0.0.1").unwrap();
        let requirement =
            ContractRequirement::new("soksak-spec-service", ">=0.0.1 <1.0.0").unwrap();
        assert_eq!(
            serde_json::to_value(&provider).unwrap(),
            serde_json::json!({"id":"soksak-spec-service","version":"0.0.1"})
        );
        assert_eq!(
            serde_json::to_value(&requirement).unwrap(),
            serde_json::json!({"id":"soksak-spec-service","range":">=0.0.1 <1.0.0"})
        );
        assert!(serde_json::from_str::<ContractProviderRef>(
            r#""soksak-spec-service@0.0.1""#
        )
        .is_err());
        assert!(serde_json::from_str::<ContractRequirement>(
            r#""soksak-spec-service@0.0.1""#
        )
        .is_err());
        assert!(serde_json::from_str::<ContractProviderRef>(
            r#"{"id":"soksak-spec-service","version":"0.0.1","legacy":true}"#,
        )
        .is_err());
    }

    #[test]
    fn ids_match_the_public_typescript_grammar() {
        for valid in [
            "soksak-spec-service",
            "soksak-spec-service-workflow",
            "soksak-spec-plugin-notes",
            "soksak-spec-sidecar-browser",
        ] {
            assert!(is_contract_id(valid), "{valid}");
        }
        for invalid in [
            "soksak-spec-service@0.0.1",
            "soksak-spec-contract-browser",
            "soksak-spec-sidecar-Upper",
            "soksak-plugin-browser",
        ] {
            assert!(!is_contract_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn deterministic_ranges_match_typescript_semantics() {
        let cases = [
            ("9.9.9", "*", Some(true)),
            ("1.1.0-alpha.1", "*", Some(false)),
            ("2.0.0", "2.0.0", Some(true)),
            ("2.0.1", "2.0.0", Some(false)),
            ("0.1.5", "^0.1.0", Some(true)),
            ("0.2.0", "^0.1.0", Some(false)),
            ("1.2.9", "~1.2.0", Some(true)),
            ("1.3.0", "~1.2.0", Some(false)),
            ("1.5.0", ">=1.0.0 <2.0.0", Some(true)),
            ("2.0.0", ">=1.0.0 <2.0.0", Some(false)),
            ("1.2.3-alpha.2", ">1.2.3-alpha.1 <1.2.3", Some(true)),
            ("1.2.4-alpha.1", ">=1.2.3-beta.1 <2.0.0", Some(false)),
            ("18446744073709551616.0.0", ">1.0.0", Some(true)),
            ("1.0", ">=1.0.0", None),
            ("1.0.0", ">=1.0.0 || <2.0.0", None),
            ("1.0.0", ">=1.0.0  <2.0.0", None),
        ];
        for (version, range, expected) in cases {
            assert_eq!(semver_satisfies(version, range), expected, "{version} {range}");
        }
    }

    #[test]
    fn requirement_matches_id_and_range_but_not_an_exact_concatenated_token() {
        let requirement = ContractRequirement::new(
            "soksak-spec-sidecar-browser",
            ">=0.0.1 <0.1.0",
        )
        .unwrap();
        assert!(requirement.matches(
            &ContractProviderRef::new("soksak-spec-sidecar-browser", "0.0.2").unwrap()
        ));
        assert!(!requirement.matches(
            &ContractProviderRef::new("soksak-spec-sidecar-browser", "0.1.0").unwrap()
        ));
        assert!(!requirement.matches(
            &ContractProviderRef::new("soksak-spec-sidecar-terminal", "0.0.2").unwrap()
        ));
    }
}
