use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const INSTALL_STATE_SPEC: &str = "soksak-installed-units@0.0.1";
const MAX_READ_UTF8_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIdentity {
    pub kind: String,
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub url: String,
    pub sha256: String,
    pub format: String,
    pub entrypoints: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTransactionReply {
    pub transaction_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedArtifactReply {
    pub handle: String,
    pub sha256: String,
    pub extraction: &'static str,
    pub verified_entrypoints: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedInstallUnit {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub registry_id: String,
    pub source_repository: String,
    pub source_commit: String,
    pub release_tag: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub staged_handle: String,
    pub providers: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReply {
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledUnitReference {
    registry_id: String,
    kind: String,
    id: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRootClosure {
    registry_id: String,
    root: UnitIdentity,
    units: Vec<InstalledUnitReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledUnit {
    #[serde(flatten)]
    release: VerifiedInstallUnit,
    generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveInstallState {
    spec: String,
    current: String,
    previous: Option<String>,
    roots: Vec<InstalledRootClosure>,
    units: Vec<InstalledUnit>,
}

#[derive(Debug)]
struct StagedArtifact {
    identity: UnitIdentity,
    handle: String,
    path: PathBuf,
    url: String,
    sha256: String,
    entrypoints: Vec<String>,
}

#[derive(Debug)]
struct InstallTransaction {
    registry_id: String,
    root: UnitIdentity,
    path: PathBuf,
    staged: HashMap<String, StagedArtifact>,
}

pub struct UnitInstallManager {
    home: PathBuf,
    transactions: Mutex<HashMap<String, InstallTransaction>>,
}

fn validate_flat_id(label: &str, value: &str, extra: &[char]) -> Result<(), String> {
    let mut chars = value.chars();
    let head = chars
        .next()
        .is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit());
    let tail = chars.all(|value| {
        value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-' || extra.contains(&value)
    });
    if head && tail && value.len() <= 128 {
        Ok(())
    } else {
        Err(format!("invalid {label}: {value:?}"))
    }
}

fn validate_identity(identity: &UnitIdentity) -> Result<(), String> {
    if !matches!(identity.kind.as_str(), "plugin" | "sidecar" | "kit") {
        return Err(format!("invalid unit kind: {:?}", identity.kind));
    }
    validate_flat_id("unit id", &identity.id, &[])?;
    if !soksak_spec_contract::is_strict_semver(&identity.version) {
        return Err(format!("invalid unit version: {:?}", identity.version));
    }
    Ok(())
}

fn validate_registry_id(value: &str) -> Result<(), String> {
    validate_flat_id("registry id", value, &['.', '_'])?;
    if value.len() > 64 {
        return Err(format!("invalid registry id: {value:?}"));
    }
    Ok(())
}

fn canonical_uuid(label: &str, value: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| format!("invalid {label}: {value:?}"))?;
    if parsed.to_string() != value {
        return Err(format!("non-canonical {label}: {value:?}"));
    }
    Ok(())
}

fn reference(unit: &VerifiedInstallUnit) -> InstalledUnitReference {
    InstalledUnitReference {
        registry_id: unit.registry_id.clone(),
        kind: unit.kind.clone(),
        id: unit.id.clone(),
        version: unit.version.clone(),
    }
}

fn identity_key(kind: &str, id: &str) -> String {
    format!("{kind}\0{id}")
}

fn exact_reference_key(unit: &InstalledUnitReference) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        unit.registry_id, unit.kind, unit.id, unit.version
    )
}

fn validate_release_asset_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != raw
    {
        return Err("artifact URL must be a canonical credential-free GitHub Release URL".into());
    }
    let segments = url
        .path_segments()
        .ok_or("artifact URL has no path segments")?
        .collect::<Vec<_>>();
    if segments.len() != 6
        || segments[2] != "releases"
        || segments[3] != "download"
        || segments.iter().any(|segment| segment.is_empty())
    {
        return Err("artifact URL must identify one GitHub Release asset".into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_stage_artifact(artifact: &StageArtifact) -> Result<Vec<String>, String> {
    validate_release_asset_url(&artifact.url)?;
    if !matches!(artifact.format.as_str(), "tar.gz" | "tgz") {
        return Err("artifact format must be tar.gz or tgz".into());
    }
    if (artifact.format == "tar.gz" && !artifact.url.ends_with(".tar.gz"))
        || (artifact.format == "tgz" && !artifact.url.ends_with(".tgz"))
    {
        return Err("artifact format does not match its asset suffix".into());
    }
    let mut entrypoints = artifact.entrypoints.clone();
    entrypoints.sort();
    if entrypoints.is_empty() || entrypoints.iter().collect::<HashSet<_>>().len() != entrypoints.len() {
        return Err("artifact entrypoints must be non-empty and unique".into());
    }
    for entrypoint in &entrypoints {
        crate::runtime_dep::validate_archive_path(entrypoint)?;
    }
    Ok(entrypoints)
}

fn validate_verified_unit(unit: &VerifiedInstallUnit) -> Result<(), String> {
    validate_identity(&UnitIdentity {
        kind: unit.kind.clone(),
        id: unit.id.clone(),
        version: unit.version.clone(),
    })?;
    validate_registry_id(&unit.registry_id)?;
    validate_release_asset_url(&unit.artifact_url)?;
    if !valid_sha256(&unit.artifact_sha256) {
        return Err("artifact sha256 must be an exact lowercase digest".into());
    }
    canonical_uuid("staged handle", &unit.staged_handle)?;
    let source = url::Url::parse(&unit.source_repository).map_err(|error| error.to_string())?;
    if source.scheme() != "https"
        || source.host_str() != Some("github.com")
        || source.port().is_some()
        || !source.username().is_empty()
        || source.password().is_some()
        || source.query().is_some()
        || source.fragment().is_some()
        || source.as_str() != unit.source_repository
        || source.path_segments().map(|segments| segments.count()) != Some(2)
    {
        return Err("source repository must be a canonical GitHub repository URL".into());
    }
    if unit.source_commit.len() != 40
        || !unit
            .source_commit
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err("source commit must be an exact lowercase 40-character SHA".into());
    }
    Ok(())
}

fn validate_active_state(state: &ActiveInstallState) -> Result<(), String> {
    if state.spec != INSTALL_STATE_SPEC {
        return Err(format!("installed unit state requires {INSTALL_STATE_SPEC}"));
    }
    canonical_uuid("active generation", &state.current)?;
    if let Some(previous) = &state.previous {
        canonical_uuid("previous generation", previous)?;
        if previous == &state.current {
            return Err("active and previous generations must differ".into());
        }
    }

    let mut installed_by_exact = HashSet::new();
    let mut installed_by_identity = HashSet::new();
    for unit in &state.units {
        validate_verified_unit(&unit.release)?;
        canonical_uuid("unit generation", &unit.generation)?;
        if !installed_by_exact.insert(exact_reference_key(&reference(&unit.release)))
            || !installed_by_identity.insert(identity_key(&unit.release.kind, &unit.release.id))
        {
            return Err("installed unit identities must be unique".into());
        }
    }

    let mut roots = HashSet::new();
    let installed = state
        .units
        .iter()
        .map(|unit| exact_reference_key(&reference(&unit.release)))
        .collect::<HashSet<_>>();
    for closure in &state.roots {
        validate_registry_id(&closure.registry_id)?;
        validate_identity(&closure.root)?;
        if !roots.insert(identity_key(&closure.root.kind, &closure.root.id)) {
            return Err("installed roots must be unique".into());
        }
        if closure.units.is_empty() {
            return Err("installed root closure must be non-empty".into());
        }
        let mut closure_units = HashSet::new();
        for unit in &closure.units {
            validate_registry_id(&unit.registry_id)?;
            validate_identity(&UnitIdentity {
                kind: unit.kind.clone(),
                id: unit.id.clone(),
                version: unit.version.clone(),
            })?;
            if unit.registry_id != closure.registry_id {
                return Err("root closure cannot cross registry boundaries".into());
            }
            let exact = exact_reference_key(unit);
            if !closure_units.insert(exact.clone()) || !installed.contains(&exact) {
                return Err("root closure differs from installed unit evidence".into());
            }
        }
        let root = InstalledUnitReference {
            registry_id: closure.registry_id.clone(),
            kind: closure.root.kind.clone(),
            id: closure.root.id.clone(),
            version: closure.root.version.clone(),
        };
        if !closure_units.contains(&exact_reference_key(&root)) {
            return Err("installed root closure omits its root".into());
        }
    }
    if state.roots.is_empty() != state.units.is_empty() {
        return Err("installed roots and units must become empty together".into());
    }
    Ok(())
}

fn read_active_state(path: &Path) -> Result<Option<ActiveInstallState>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let state: ActiveInstallState = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            validate_active_state(&state)?;
            Ok(Some(state))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("state path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    crate::path_security::reject_symlink_components(parent)?;
    let temporary = parent.join(format!(".state-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            OpenOptions::new()
                .read(true)
                .open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

impl UnitInstallManager {
    pub fn new(home: PathBuf) -> Result<Self, String> {
        if !home.is_absolute() {
            return Err("unit installer home must be absolute".into());
        }
        fs::create_dir_all(&home).map_err(|error| error.to_string())?;
        crate::path_security::reject_symlink_components(&home)?;
        let staging = home.join("install-staging");
        fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        crate::path_security::reject_symlink_components(&staging)?;
        for item in fs::read_dir(&staging).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(item.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(item.path()).map_err(|error| error.to_string())?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(item.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(Self { home, transactions: Mutex::new(HashMap::new()) })
    }

    fn staging_root(&self) -> PathBuf {
        self.home.join("install-staging")
    }

    fn generations_root(&self) -> PathBuf {
        self.home.join("unit-generations")
    }

    fn active_state_path(&self) -> PathBuf {
        self.home.join("installed-units.json")
    }

    fn begin(&self, registry_id: String, root: UnitIdentity) -> Result<InstallTransactionReply, String> {
        validate_registry_id(&registry_id)?;
        validate_identity(&root)?;
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let path = self.staging_root().join(&transaction_id);
        fs::create_dir(&path).map_err(|error| error.to_string())?;
        let transaction = InstallTransaction {
            registry_id,
            root,
            path,
            staged: HashMap::new(),
        };
        self.transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .insert(transaction_id.clone(), transaction);
        Ok(InstallTransactionReply { transaction_id })
    }

    fn stage_bytes(
        &self,
        transaction_id: &str,
        registry_id: &str,
        unit: UnitIdentity,
        artifact: StageArtifact,
        body: &[u8],
    ) -> Result<StagedArtifactReply, String> {
        validate_identity(&unit)?;
        let entrypoints = validate_stage_artifact(&artifact)?;
        let mut transactions = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?;
        let transaction = transactions
            .get_mut(transaction_id)
            .ok_or("unit install transaction not found")?;
        if transaction.registry_id != registry_id {
            return Err("registry identity differs from transaction".into());
        }
        if transaction
            .staged
            .values()
            .any(|staged| staged.identity == unit)
        {
            return Err("unit release is already staged in this transaction".into());
        }
        let handle = uuid::Uuid::new_v4().to_string();
        let path = transaction.path.join(&handle);
        crate::runtime_dep::unpack_verify_install_entries(
            body,
            &artifact.sha256,
            &path,
            &entrypoints,
        )?;
        transaction.staged.insert(
            handle.clone(),
            StagedArtifact {
                identity: unit,
                handle: handle.clone(),
                path,
                url: artifact.url,
                sha256: artifact.sha256.clone(),
                entrypoints: entrypoints.clone(),
            },
        );
        Ok(StagedArtifactReply {
            handle,
            sha256: artifact.sha256,
            extraction: "regular-files-only",
            verified_entrypoints: entrypoints,
        })
    }

    fn read_utf8(&self, transaction_id: &str, handle: &str, path: &str) -> Result<String, String> {
        let relative = crate::runtime_dep::validate_archive_path(path)?;
        let transactions = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?;
        let transaction = transactions
            .get(transaction_id)
            .ok_or("unit install transaction not found")?;
        let staged = transaction.staged.get(handle).ok_or("staged artifact not found")?;
        let file_path = staged.path.join(relative);
        let metadata = fs::symlink_metadata(&file_path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("staged path is not a regular file".into());
        }
        if metadata.len() > MAX_READ_UTF8_BYTES {
            return Err(format!("staged text exceeds {MAX_READ_UTF8_BYTES} bytes"));
        }
        fs::read_to_string(file_path).map_err(|error| error.to_string())
    }

    fn validate_commit(
        transaction: &InstallTransaction,
        units: &[VerifiedInstallUnit],
    ) -> Result<(), String> {
        if units.len() != transaction.staged.len() || units.is_empty() {
            return Err("verified closure differs from staged artifact set".into());
        }
        let mut handles = HashSet::new();
        let mut identities = HashSet::new();
        for unit in units {
            let identity = UnitIdentity {
                kind: unit.kind.clone(),
                id: unit.id.clone(),
                version: unit.version.clone(),
            };
            validate_verified_unit(unit)?;
            if unit.registry_id != transaction.registry_id {
                return Err("verified unit registry differs from transaction".into());
            }
            if !handles.insert(unit.staged_handle.clone()) || !identities.insert(identity.clone()) {
                return Err("duplicate verified unit or staged handle".into());
            }
            let staged = transaction
                .staged
                .get(&unit.staged_handle)
                .ok_or("verified unit refers to an unknown staged handle")?;
            if staged.identity != identity
                || staged.handle != unit.staged_handle
                || staged.url != unit.artifact_url
                || staged.sha256 != unit.artifact_sha256
                || staged.entrypoints.is_empty()
            {
                return Err("verified unit evidence differs from staged artifact".into());
            }
        }
        let root_present = units.iter().any(|unit| {
            unit.kind == transaction.root.kind
                && unit.id == transaction.root.id
                && unit.version == transaction.root.version
        });
        if !root_present {
            return Err("verified closure omits the transaction root".into());
        }
        Ok(())
    }

    fn compose_state(
        transaction: &InstallTransaction,
        units: Vec<VerifiedInstallUnit>,
        generation: &str,
        prior: Option<ActiveInstallState>,
    ) -> Result<ActiveInstallState, String> {
        let root_key = identity_key(&transaction.root.kind, &transaction.root.id);
        let mut roots = prior
            .as_ref()
            .map(|state| state.roots.clone())
            .unwrap_or_default();
        roots.retain(|closure| identity_key(&closure.root.kind, &closure.root.id) != root_key);

        let mut closure_units = units.iter().map(reference).collect::<Vec<_>>();
        closure_units.sort();
        roots.push(InstalledRootClosure {
            registry_id: transaction.registry_id.clone(),
            root: transaction.root.clone(),
            units: closure_units,
        });
        roots.sort_by(|left, right| {
            (&left.root.kind, &left.root.id).cmp(&(&right.root.kind, &right.root.id))
        });

        let mut available = prior
            .map(|state| {
                state
                    .units
                    .into_iter()
                    .map(|unit| (exact_reference_key(&reference(&unit.release)), unit))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        for release in units {
            let installed = InstalledUnit {
                release,
                generation: generation.to_string(),
            };
            available.insert(
                exact_reference_key(&reference(&installed.release)),
                installed,
            );
        }

        let mut wanted_by_identity = HashMap::<String, InstalledUnitReference>::new();
        for closure in &roots {
            for unit in &closure.units {
                let key = identity_key(&unit.kind, &unit.id);
                if let Some(wanted) = wanted_by_identity.get(&key) {
                    if wanted != unit {
                        return Err(format!(
                            "installed roots require incompatible releases for {}:{}",
                            unit.kind, unit.id
                        ));
                    }
                } else {
                    wanted_by_identity.insert(key, unit.clone());
                }
            }
        }

        let mut installed = wanted_by_identity
            .values()
            .map(|wanted| {
                available
                    .remove(&exact_reference_key(wanted))
                    .ok_or_else(|| {
                        format!(
                            "installed evidence is missing for {}:{}@{}",
                            wanted.kind, wanted.id, wanted.version
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        installed.sort_by(|left, right| {
            (
                &left.release.kind,
                &left.release.id,
                &left.release.registry_id,
                &left.release.version,
            )
                .cmp(&(
                    &right.release.kind,
                    &right.release.id,
                    &right.release.registry_id,
                    &right.release.version,
                ))
        });

        let state = ActiveInstallState {
            spec: INSTALL_STATE_SPEC.to_string(),
            current: generation.to_string(),
            previous: roots
                .first()
                .and_then(|_| prior.as_ref().map(|state| state.current.clone())),
            roots,
            units: installed,
        };
        validate_active_state(&state)?;
        Ok(state)
    }

    fn commit(&self, transaction_id: &str, units: Vec<VerifiedInstallUnit>) -> Result<CommitReply, String> {
        let transaction = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .remove(transaction_id)
            .ok_or("unit install transaction not found")?;
        if let Err(error) = Self::validate_commit(&transaction, &units) {
            self.transactions
                .lock()
                .map_err(|_| "unit installer lock poisoned".to_string())?
                .insert(transaction_id.to_string(), transaction);
            return Err(error);
        }
        let generation = uuid::Uuid::new_v4().to_string();
        let prior = match read_active_state(&self.active_state_path()) {
            Ok(value) => value,
            Err(error) => {
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
                return Err(error);
            }
        };
        let state = match Self::compose_state(&transaction, units, &generation, prior) {
            Ok(state) => state,
            Err(error) => {
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
                return Err(error);
            }
        };
        let generations = self.generations_root();
        fs::create_dir_all(&generations).map_err(|error| error.to_string())?;
        crate::path_security::reject_symlink_components(&generations)?;
        let destination = generations.join(&generation);
        fs::rename(&transaction.path, &destination).map_err(|error| error.to_string())?;
        let persist = write_json_atomic(&destination.join("generation.json"), &state)
            .and_then(|()| write_json_atomic(&self.active_state_path(), &state));
        if let Err(error) = persist {
            let restored = fs::rename(&destination, &transaction.path).is_ok();
            if restored {
                let _ = fs::remove_file(transaction.path.join("generation.json"));
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
            }
            return Err(error);
        }
        Ok(CommitReply { generation })
    }

    fn rollback(&self, transaction_id: &str) -> Result<(), String> {
        let transaction = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .remove(transaction_id)
            .ok_or("unit install transaction not found")?;
        fs::remove_dir_all(transaction.path).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn unit_install_begin(
    manager: tauri::State<'_, UnitInstallManager>,
    registry_id: String,
    root: UnitIdentity,
) -> Result<InstallTransactionReply, String> {
    manager.begin(registry_id, root)
}

#[tauri::command]
pub fn unit_install_stage(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    registry_id: String,
    unit: UnitIdentity,
    artifact: StageArtifact,
) -> Result<StagedArtifactReply, String> {
    let body = crate::runtime_dep::download_verified_bytes(&artifact.url, &artifact.sha256)?;
    manager.stage_bytes(&transaction_id, &registry_id, unit, artifact, &body)
}

#[tauri::command]
pub fn unit_install_read_utf8(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    handle: String,
    path: String,
) -> Result<String, String> {
    manager.read_utf8(&transaction_id, &handle, &path)
}

#[tauri::command]
pub fn unit_install_commit(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    units: Vec<VerifiedInstallUnit>,
) -> Result<CommitReply, String> {
    manager.commit(&transaction_id, units)
}

#[tauri::command]
pub fn unit_install_rollback(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
) -> Result<(), String> {
    manager.rollback(&transaction_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    fn home(name: &str) -> PathBuf {
        let base = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        let path = base.join(format!("soksak-unit-installer-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(body.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, path, Cursor::new(*body)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn digest(body: &[u8]) -> String {
        Sha256::digest(body).iter().map(|value| format!("{value:02x}")).collect()
    }

    fn identity() -> UnitIdentity {
        UnitIdentity { kind: "plugin".into(), id: "weather-plugin".into(), version: "0.0.1".into() }
    }

    fn artifact(sha256: String) -> StageArtifact {
        StageArtifact {
            url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
            sha256,
            format: "tgz".into(),
            entrypoints: vec!["plugin.json".into()],
        }
    }

    fn verified(handle: String, sha256: String) -> VerifiedInstallUnit {
        VerifiedInstallUnit {
            kind: "plugin".into(),
            id: "weather-plugin".into(),
            version: "0.0.1".into(),
            registry_id: "fixture".into(),
            source_repository: "https://github.com/example/weather-plugin".into(),
            source_commit: "a".repeat(40),
            release_tag: "v0.0.1".into(),
            artifact_url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
            artifact_sha256: sha256,
            staged_handle: handle,
            providers: Vec::new(),
        }
    }

    fn second_identity() -> UnitIdentity {
        UnitIdentity { kind: "plugin".into(), id: "notes-plugin".into(), version: "0.0.1".into() }
    }

    fn second_artifact(sha256: String) -> StageArtifact {
        StageArtifact {
            url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
            sha256,
            format: "tgz".into(),
            entrypoints: vec!["plugin.json".into()],
        }
    }

    fn second_verified(handle: String, sha256: String) -> VerifiedInstallUnit {
        VerifiedInstallUnit {
            kind: "plugin".into(),
            id: "notes-plugin".into(),
            version: "0.0.1".into(),
            registry_id: "fixture".into(),
            source_repository: "https://github.com/example/notes-plugin".into(),
            source_commit: "b".repeat(40),
            release_tag: "v0.0.1".into(),
            artifact_url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
            artifact_sha256: sha256,
            staged_handle: handle,
            providers: Vec::new(),
        }
    }

    #[test]
    fn commits_one_verified_generation_and_declares_the_active_absolute_root() {
        let home = home("commit");
        let manager = UnitInstallManager::new(home.clone()).unwrap();
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
        let sha256 = digest(&body);
        let staged = manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
            .unwrap();
        assert_eq!(
            manager.read_utf8(&transaction.transaction_id, &staged.handle, "plugin.json").unwrap(),
            r#"{"id":"weather-plugin"}"#
        );
        let committed = manager
            .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
            .unwrap();
        let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
        assert_eq!(active.current, committed.generation);
        assert!(home.join("unit-generations").join(&committed.generation).is_dir());
        assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn digest_failure_leaves_no_staged_unit_and_transaction_can_roll_back() {
        let home = home("digest");
        let manager = UnitInstallManager::new(home.clone()).unwrap();
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", b"{}")]);
        let error = manager
            .stage_bytes(
                &transaction.transaction_id,
                "fixture",
                identity(),
                artifact("0".repeat(64)),
                &body,
            )
            .unwrap_err();
        assert!(error.contains("sha256"));
        manager.rollback(&transaction.transaction_id).unwrap();
        assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn commit_rejects_partial_evidence_without_consuming_the_transaction() {
        let home = home("partial");
        let manager = UnitInstallManager::new(home.clone()).unwrap();
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", b"{}")]);
        let sha256 = digest(&body);
        manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256), &body)
            .unwrap();
        let error = manager.commit(&transaction.transaction_id, Vec::new()).unwrap_err();
        assert!(error.contains("closure"));
        manager.rollback(&transaction.transaction_id).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn independent_root_commits_preserve_both_verified_closures() {
        let home = home("multiple-roots");
        let manager = UnitInstallManager::new(home.clone()).unwrap();

        let first = manager.begin("fixture".into(), identity()).unwrap();
        let first_body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#)]);
        let first_sha = digest(&first_body);
        let first_staged = manager
            .stage_bytes(&first.transaction_id, "fixture", identity(), artifact(first_sha.clone()), &first_body)
            .unwrap();
        manager
            .commit(&first.transaction_id, vec![verified(first_staged.handle, first_sha)])
            .unwrap();

        let second = manager.begin("fixture".into(), second_identity()).unwrap();
        let second_body = archive(&[("plugin.json", br#"{"id":"notes-plugin"}"#)]);
        let second_sha = digest(&second_body);
        let second_staged = manager
            .stage_bytes(
                &second.transaction_id,
                "fixture",
                second_identity(),
                second_artifact(second_sha.clone()),
                &second_body,
            )
            .unwrap();
        manager
            .commit(
                &second.transaction_id,
                vec![second_verified(second_staged.handle, second_sha)],
            )
            .unwrap();

        let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
        let ids = active.units.iter().map(|unit| unit.id.as_str()).collect::<HashSet<_>>();
        assert_eq!(ids, HashSet::from(["notes-plugin", "weather-plugin"]));
        fs::remove_dir_all(home).unwrap();
    }
}
