# Provoz a diagnostika

## Dvě různé kontroly

```powershell
# Pouze Node/MCP handshake a přesná veřejná schémata; bez native CLI/loginu:
npm.cmd --prefix bridge run doctor
npm.cmd --prefix bridge run doctor -- --help
# Výslovný native metadata/preflight, nikdy odeslání úlohy:
npm.cmd --prefix bridge run doctor -- --native --cwd 'C:/Projects/My App' --model opus
```

U instalované kopie použij `node <instalovaný-adresář>/doctor.js`. Aby explicitní
native kontrola odpovídala registraci, nastav stejné `CLAUDE_BRIDGE_COMMAND`,
`CLAUDE_BRIDGE_MODEL` a případné `CLAUDE_BRIDGE_CONFIG_DIR`. Samotné umístění
`doctor.js` nenačte env z MCP registrace.

Výchozí doctor má 10s limit pro initialize i tools/list, plus omezený úklid
transportu. Nespouští auth/preflight/model ani nevytváří konverzaci. Chybná schémata
neprojdou jen proto, že existují správné názvy nástrojů.

`--native` používá stejnou zmrazenou validaci jako runtime: zdroje settings,
verze/help, saved-login auth metadata, personal-policy eligibility a stabilita
zdrojů. Nativní metadata subprocess má limit 18 s a společný limit stdout/stderr
256 KiB; několik příkazů znamená delší celkový čas. Nevolá launch ani další recheck,
neukládá pending a neposílá zadání. Výstup je omezený na kódy, kanonický model,
verzi/kontrakt, režim profilu a ne-tajné fingerprinty; bez emailu, cest, tokenů,
env hodnot či raw auth JSON. Fingerprinty také zbytečně veřejně nesdílej.

**Úspěch není live credentials / model entitlement důkaz.** Native `auth status`
může při běžném provozu kontaktovat ancillary služby a native metadata příkazy
mohou změnit lokální metadata. Skutečný preflight není air-gap/no-network režim.
Doctor automaticky neopravuje profil, nepřihlašuje, neobnovuje tokeny ani nepouští
smoke. Neznámé přepínače, chybějící hodnoty a relativní `--cwd` odmítá. Nemá veřejné
parametry pro testovací transport/provider/auth.

## Instalace, společné discovery roots a aktualizace

```powershell
.\install.ps1 -Target Claude
# Volitelně jedna instalace i pro Codex:
.\install.ps1 -Target Both
```

`-Target Codex` je kompatibilní default. Claude-only / `-SkipRegister` nepotřebují
Codex CLI; všechny cíle instalátoru potřebují lokální Node, npm.cmd a claude.exe.
Instalátor používá `npm ci --no-audit --no-fund`; nejde o offline ani dry-run akci.
`-SkipRegister` stále zapisuje server/skills a provede neinferenční doctor.

- `-CodexRoot` (default `CODEX_HOME` nebo `~/.codex`) určuje `bridges/claude-bridge`
  a `state/claude-bridge`, také pro Claude-only.
- `-SkillRoot`: Codex discovery, standardně `~/.agents/skills`.
- `-ClaudeSkillRoot`: společné Claude/Claudex discovery, standardně
  `~/.claude/skills` nebo rodičovské `CLAUDE_CONFIG_DIR/skills`.
- `-NativeConfigRoot`: volitelný **existující absolutní NFC root dítěte**.
  Zachová přesný přijatý řetězec; nativní auth namespace může rozlišit i jiný zápis
  stejného adresáře. Nezaměňuj jej s rodičovským rootem.
- `-Model opus`, `-PermissionMode dontAsk`, `-AllowedTools @()`,
  `-TimeoutSeconds 900` jsou defaulty. `AllowedTools` nesmí být CLI přepínače.

Sdílená rodičovská user registrace `claude_bridge` vzniká nativním
`claude mcp add-json ... --scope user`; patří do `~/.claude.json`, případně
`CLAUDE_CONFIG_DIR/.claude.json`, **ne do settings.json**. Claude/Claudex potřebují
stejné rodičovské roots. Skill se instaluje jako `claude-peer`, shodné cílové cesty
se deduplikují, bez symlinků. Codex je samostatná volitelná registrace.

Instalátor kontroluje také kolize lokální/projektové Claude registrace. Restartuj
rodiče po změně. Ověření registrace nativním `claude mcp get claude_bridge` může
spouštět kontrolu spojení; není náhradou samostatného souhlasu s instalací.
**Pouhé přesměrování `-CodexRoot`/`-SkillRoot` neizoluje nativní user registraci.**
Instalační test vyžaduje kompletní syntetický home/config/env, ne jen jiné cíle.

Aktualizace mění jen vlastněné soubory a položky. Zálohy jsou v
`.claude-bridge-backup-*` vedle instalačního adresáře; úspěšná aktualizace může
obsahovat `files.json`, chyba `recovery.json`. Nejde o úplnou zálohu uživatelského
profilu. `INSTALL_FILE_COLLISION`, `INSTALL_SKILL_COLLISION`,
`INSTALL_REGISTRATION_COLLISION` znamenají nesoulad vlastnictví: nejdříve porovnej
místní změny, nepřepisuj je naslepo. `INSTALL_CONCURRENT_FILE_CHANGE` /
`INSTALL_CONCURRENT_REGISTRATION_CHANGE` značí změnu během instalace.

`automatic rollback incomplete; preserve the recovery backup` znamená ruční
kontrolu: zachovej backup, current config i spravované soubory. Rollback záměrně
nepřepisuje nerozpoznaný souběžný zápis starým snapshotem. `INSTALL_LOCKED` neřeš
smazáním živého locku. Celý starý `.claude.json`/TOML nikdy nekopíruj přes nový.
Mezi PC nepřenášej credentials, nativní sessions ani absolutní registraci; proveď
místní instalaci a samostatné legitimní přihlášení na každém PC.

## Konfigurace dítěte

| Proměnná | Význam / výchozí hodnota |
|---|---|
| `CLAUDE_BRIDGE_COMMAND` | Absolutní nativní `.exe`; instalátor najde místní `claude.exe`. Runtime default na Windows je `~/.local/bin/claude.exe`. Žádné `.cmd/.bat/.ps1` shimy. |
| `CLAUDE_BRIDGE_STATE_DIR` | Bridge stav; default `$CODEX_HOME/state/claude-bridge` nebo `~/.codex/state/claude-bridge`. |
| `CLAUDE_BRIDGE_CONFIG_DIR` | Pouze explicitní existující profil dítěte. Bez ní standardní `~/.claude`, počáteční child `CLAUDE_CONFIG_DIR` je vynechané. |
| `CLAUDE_BRIDGE_MODEL` | `opus` → `claude-opus-5[1m]`; nezávislé na aliasu/modelu rodiče. |
| `CLAUDE_BRIDGE_TIMEOUT_MS` | 900000; validace 1000–86400000 ms. Instalátor dovoluje 10–86400 s. |
| `CLAUDE_BRIDGE_PERMISSION_MODE` | `dontAsk`; dále `acceptEdits`, `plan`, `default`, `auto`. |
| `CLAUDE_BRIDGE_ALLOWED_TOOLS` | JSON pole permission pravidel, default `[]`. Není vypnutí nástrojů. |
| `CLAUDE_BRIDGE_DISABLE_TOOLS` | Striktně řetězec `0` nebo `1`; bez nastavení / `0` = normální nástroje, `1` = doslova prázdný native argument `--tools`, odstranění implementací nástrojů. Nová v2 tuto boolean policy připne. |

Katalog přijímá jen `opus`, `opus[1m]`, `claude-opus-5`, `claude-opus-5[1m]`.
U nové konverzace platí explicitní `claude_turn.model` → bridge env → Opus.
Sonnet/Haiku, GPT/gateway ID, `inherit`, `default`, `opusplan` a jiné hodnoty
odmítne. Žádný automatický provider/model fallback. `[1m]` je context selector;
strukturované usage může uvést základní `claude-opus-5`.

Routing se izoluje jen v dítěti: rodičovské prostředí se nemění. Nativní CLI
používá uložené osobní Pro/Max first-party přihlášení, ne přenesené OAuth/API env.
Gateway (i vedle uloženého Max), Team/Enterprise/unknown účty a neověřitelné
managed routing zdroje se odmítají, nikoli obcházejí. Ne-NFC filesystem profily,
root konflikty a nepodporovaná nepřímá cesta jsou nepodporované. Bridge adaptér
credential-bearing soubory neparsuje, pouze kontroluje jejich metadata.

Normální user/project/local settings, CLAUDE.md, skills a permission context se
zachovají. Hooks jsou vypnuté, child MCP je strict a prázdné, rekurzivní bridge
se odmítá. Nedostupný delegovací nástroj nepřemosťuj jinou cestou. `dontAsk` a
prázdné allow pole **nejsou** read-only ani tool-free policy; zděděné allow/deny
pravidlo může změnit výsledek. Kontroluj `permission_denials`, nevynucuj úspěch
eskalací oprávnění. Nejde o OS sandbox ani globální atomickou policy garanci po
odeslání úlohy. Native transcripty zůstávají lokálně.

## Native chyby před spuštěním

| Kód | Bezpečný další postup |
|---|---|
| `NATIVE_PLATFORM`, `NATIVE_COMPATIBILITY` | Ověř Windows a přesně 2.1.263; nepoužívej automaticky jinou verzi/fallback. |
| `NATIVE_MODEL` | Použij podporovaný katalog; existující model nepřepisuj. |
| `NATIVE_ROOT`, `NATIVE_INPUT` | Ověř absolutní existující root/cwd/executable, NFC a shodný home. Neopravuj namespace normalizací. |
| `NATIVE_SOURCE` | Zkontroluj podporovanost/čitelnost settings, bez zveřejňování jejich obsahu. |
| `NATIVE_CONFLICT`, `NATIVE_POLICY` | Routing/policy není doložená; neodstraňuj managed policy a nezaváděj bypass. |
| `NATIVE_AUTH` | Chybí podporovaná saved personal first-party metadata. Případné legitimní přihlášení je oddělený operátorský krok. |
| `NATIVE_DIAGNOSTIC` | Metadata subprocess selhal nebo překročil limit; uchovej sanitizované důkazy, ne raw auth výstup. |
| `NATIVE_DRIFT` | Změna zdrojů/identity před submission; viz reliability 47. Žádné retry-until-green. |

`CLAUDE_AUTH_FAILED` (například native 401) po zahájení úlohy už není totéž co
preflight chyba. Neprováděj automatický login/refresh ani znovuodeslání. Nejprve
stav a dopady, přihlášení/přístup k modelu řeš zvlášť. MCP timeout rodiče nastav
dostatečně dlouhý; Codex instalátor nastavuje startup 30 s a tool timeout
`TimeoutSeconds + 60` pomocí zachovaného timeout helperu.

## Přerušený tah, v1 a stav

1. Zavolej `claude_status` se stejným `conversation_id`. Startup/status/cache
   nepotřebují native preflight ani funkční executable/login.
2. `ready`: vyzvedni `last_result` nebo přesně dokončený request ID a stejnou
   zprávu. Cache nepřidá tah, nepotřebuje aktuální native login. Jiné tělo se
   stejným ID je `REQUEST_ID_CONFLICT`.
3. **v1**: pouze status a přesný completed replay. Nový tah je `LEGACY_SESSION`;
   žádná automatická migrace či nahrazení session.
4. **v2**: kanonický model, runtime/account/executable identita, přesný profil,
   cwd a bridge policy jsou připnuté. Změna defaultu je nepřepíše. Statusové
   `inference_allowed` popisuje stav, **není nový preflight ani příslib entitlementu**.
   Nová v2 ukládá `policy.disableTools: true|false`. Změna env ji přes restart
   nepřepne ani jedním směrem. Stará v2 bez tohoto pole zachová historický normální
   režim bez migrace/doplnění pole; v1 se novou policy nereinterpretuje. Vypnutí
   nástrojů tak vyžaduje novou konverzaci založenou s `CLAUDE_BRIDGE_DISABLE_TOOLS=1`.
   Veřejné MCP vstupy se nemění; libovolné args/provider/auth test volby neexistují.
5. Nový tah nejprve provede preflight, pak durable `pending`, pak finální recheck
   bezprostředně před supervised spawnem. Odmítnutí před submission callbackem
   obnoví původní ready snapshot; pokud se obnova neuloží, pending bezpečně zůstane.
   Nová alokovaná turn-0 session se nemaže ani nevymění.
6. Selhání po callbacku zůstává `uncertain`: subprocess mohl provést změny.
   Prohlédni pracovní adresář a lokální transcript uvedené session. Nic automaticky
   neopakuj a nemaž stav. Nové ID po vědomém operátorském rozhodnutí je **nová
   historie**, nikoli obnova původní session.

Konkurent stejné konverzace dostane `CONVERSATION_BUSY`. Lock obsahuje PID,
hostname a čas, automaticky se nepřebírá. Teprve po ověření smrti původního serveru
**i dítěte** lze řešit konkrétní osiřelý lock; pending/uncertain tím nezmizí.
Různá conversation ID mohou sdílet nativní profil, nejsou globálně serializovaná.

`CORRUPT_STATE` není prázdná historie. Nemaž stav jako cache; jeho ztrátu nelze
odlišit od nového conversation ID. Bridge stav i odpovídající nativní transcript
jsou nutné pro kontinuitu. Pro ruční `claude --resume <session_id>` by musel
operátor zachovat správný nativní executable/profil/cwd; nespouštěj současně bridge
ani nepředpokládej, že ruční pokračování má bridge routing/permission guardy.

Stav obsahuje odpovědi a cache, native transcript zadání/výsledky. Úložiště
nesdílej s nedůvěryhodnými uživateli; Windows dědí ACL. Atomic rename/flush nejsou
garance při poruše disku. Automatické mazání profilů/transcriptů bridge nenabízí.

<a id="reliability-47"></a>
## Reliability 47: neuzavřené NATIVE_DRIFT

Historicky Q-A2 integration běh měl **26 PASS / 4 FAIL**, další nezměněné běhy
30/30. První nezávislé probes měly 5/7, následně 7/7. Spontánní chyby na
`native-runtime.js:481/487` pozdější omezené D/R-D/Q-D tracing testy nereprodukovaly
ani nevysvětlily. **Zelený rerun není root cause nebo reliability PASS.**

- Řádek 481 porovnává zdroje **bez `.claude.json`**. Známý první global metadata
  zápis jej sám nevysvětluje.
- Q-D zvlášť doložil očekávané odmítnutí na 487 při řízeném překrytí dvou
  příprav na stejném syntetickém profilu: accepted writer A změnil global soubor
  během stabilního baseline B (844 → 966 bajtů). B nic neodeslal; následná
  identita byla stejná. To vysvětluje **tento řízený scénář**, ne historické 481.
- Konzervativní prelaunch odmítnutí chrání submission, ale znamená reálné omezení
  dostupnosti. Bridge neimplementuje globální zámek profilu ani retry acceptance.

Uchovej první selhaný log a verze/hashes. Při dalším výskytu pozoruj sanitizovaná
per-source metadata/digests a inventory přes **privátní syntetické testovací seams**,
bez parsování credentials a bez oslabení guardů. Starší observer měl jen metadata
a agregátní hashe; nelze slibovat lokalizaci každé registry/hash/inventory změny.
Volitelný `test/native-observer-fixture.js` je jen testovací preload, ne veřejný
runtime přepínač. Zápis evidence může ovlivnit časování. Logy hashuj až po uzavření
jejich writerů; první starý diagnostic manifest zachytil svůj log příliš brzy.
Finální release stále vyžaduje explicitní disposition položky 47.

## Offline testy, CI a smoke

```powershell
npm.cmd --prefix bridge ci --ignore-scripts --no-audit --no-fund
$env:NATIVE_CONTRACT_CLAUDE_EXE = (Get-Command claude.exe -CommandType Application | Select-Object -First 1).Source
npm.cmd --prefix bridge test
npm.cmd --prefix bridge run doctor
# Dílčí skupiny, nikoli náhrada plného gate:
npm.cmd --prefix bridge run test:unit
npm.cmd --prefix bridge run test:native
npm.cmd --prefix bridge run test:installer
```

Explicitní seznamy souborů jsou kompatibilní s Windows/Node20, bez shell globů.
Úplný suite vyžaduje Windows, oba PowerShell shelly, .NET Framework compiler a
**skutečné Claude 2.1.263**. Prerequisite test selže při chybějících shellech místo
akceptace přeskočených installer testů. Native suites ověřují verzi/flags, používají
disposable syntetické home/config/project profily, loopback a ancillary deny
proxy; žádné reálné credentials ani modelové služby. Testovací API-key či fallback
negativní/pozitivní controls nejsou podpora těchto režimů ve veřejném runtime.
Instalační suite používá offline doubles CLI/npm/doctor; sama nedokládá celou
reálnou instalaci nebo reálnou Codex serializaci. Oddělený full-source rehearsal
musí přesně uvést své zbývající doubles. Nejde o OS sandbox/entitlement důkaz.

### Historický blocker installer testu na Node20; B4 čeká na finální gate

Dřívější C aggregate na ověřeném portable Node **20.20.0** nebyl úspěšný:
installer fixture vytvořila hardlink běžícího executable a úklid odmítl `EPERM`
(`unlink`). Minimální reprodukce se stejnými cleanup parametry selhala přibližně
po 24,6 s; Node24 ekvivalentní link odstranil. Dlouhý installer proces byl tehdy
explicitně ukončen. Non-installer 112 PASS nebylo celý Node20 aggregate PASS.

Opravu fixture a discovery více PATH kandidátů nyní vlastní B4; její nezávislé
kontroly a finální current-source aggregate musí potvrdit uzavření. C2 installer
suite během B4 změn nespouští. Historická evidence zůstává zachovaná; žádné skipy,
ignorování cleanup chyby nebo retry-to-green. Tento infrastrukturní problém je
oddělený od nevyřešené native reliability 47.

<a id="native-ci-provisioning"></a>
### Pinovaný native CI provisioning

Windows matice **20.20.0 / 24.12.0** má unit/installer job a samostatný fail-closed
native-contract job. CI npm používá lockfile a `--ignore-scripts --no-audit --no-fund`.
Všechny suites včetně `tool-free.test.js`, `tool-free-native.test.js` a
`provision-native.test.js` jsou explicitně v `npm test`; odpovídající unit/native
podskupiny je zahrnují. Žádný živý smoke ani automatický login.

`bridge/ci/provision-native.js --output <nový-absolutní-adresář>` je samostatný
CI-only downloader, nikoli instalátor nebo veřejná konfigurace bridge. Rodič
výstupního adresáře musí existovat, výstupní adresář ještě nesmí existovat.
Stahuje přímo executable, takže není potřeba rozbalování archivu. Přijaté bajty
mají pevný limit/velikost a SHA256; soubor `claude.exe` vznikne přejmenováním až
po úspěšném ověření. Helper nikdy nic nespouští. Při chybě uklidí jen právě
vytvořený vlastní adresář; existující cíl odmítne a zachová. Celkový download limit
je 120 s, bez retry a bez fallbacku. Podpora provisioning helperu: Windows x64.

Přesný pin doložený 2026-09-08:

- Oficiální distribuci určuje [bootstrap.ps1](https://downloads.claude.ai/claude-code-releases/bootstrap.ps1), pouze přečtený, nikoli spuštěný.
- [Manifest 2.1.263](https://downloads.claude.ai/claude-code-releases/2.1.263/manifest.json), `platforms.win32-x64`.
- [Přímý executable](https://downloads.claude.ai/claude-code-releases/2.1.263/win32-x64/claude.exe), **218746016 bajtů**.
- SHA256 **`0b35df94c1307004f07b738390bfef8dfca5e9af29aaf6517f305bf086b95b03`**.
- [Detached manifest signature](https://downloads.claude.ai/claude-code-releases/2.1.263/manifest.json.sig) byla ověřena odděleně s [oficiálním klíčem](https://downloads.claude.ai/keys/claude-code.asc), fingerprint **`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`**, porovnaným s [oficiální dokumentací](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing).

CI používá již revidovaný pevný checksum v kódu; nestahuje za běhu nový trust key
ani nepřebírá nový hash z neověřeného manifestu. Jen přesná HTTPS URL, explicitní
TLS ověření (`rejectUnauthorized: true`), žádné redirecty, komprimovaná odpověď, `latest`, arbitrary URL/SHA env
nebo executable dodaný forkem. Nový pin vyžaduje novou kontrolu provenience a review.
Oficiální přesná verze byla dostupná; repository-variable fallback není potřeba.

Pro PR se helper checkoutuje zvlášť z `github.repository` a přesného
`pull_request.base.sha`; testovaný kód je normální PR checkout. Pro push se používá
`github.sha`. Helper z fork/head změn se pro provision nespouští. Při prvním PR
zavádějícím tuto schopnost může helper na base větvi ještě chybět: **externí
bootstrap BLOCKED**, dokud na důvěryhodné base větvi není revidovaný helper.
Neobcházej to přepnutím na fork/head helper nebo přenosem místního executable.

Po downloadu CI nastaví jen jobové `NATIVE_CONTRACT_CLAUDE_EXE` a před inference
spustí version/help kontrolu přes syntetickou fixture s loopback/ancillary deny
proxy. Runtime suites následně ověřují preflight a skutečné nativní chování.
Chybějící síť/artefakt/kompatibilita znamená selhání gate, nikdy successful skip.
Lokální offline test helperu používá soukromý loopback transport a syntetické
bajty, nedokládá hosted provoz. Lokálně byl zvlášť stažen a ověřen i přesný oficiální
artefakt do disposable temp; nejde o instalaci, publikaci nebo hosted workflow run.

### Živý smoke jen po zvláštním souhlasu

```powershell
# Toto je živá, potenciálně placená akce; nespouštěj jako součást offline testů:
npm.cmd --prefix bridge run smoke -- --live
# Alternativou opt-in je CLAUDE_BRIDGE_LIVE=1 pro tento proces.
```

Bez opt-in script vrací `SMOKE_OPT_IN_REQUIRED`, exit 1, bez MCP/úlohy i nových
souborů. `--help` je inertní. Jiné argumenty odmítne (`SMOKE_ARGUMENTS`); žádný
model/provider/transport parametr. Se souhlasem nastaví pouze child bridge policy:
`CLAUDE_BRIDGE_DISABLE_TOOLS=1`, `dontAsk`, `allowedTools=[]`, Opus a timeout 120 s.
Nejde o prázdná oprávnění vydávaná za zákaz nástrojů: skutečný **native 2.1.263
`--tools` s prázdným argumentem** odstraní implementace. Offline actual-native
controls ověřují nulovou nabídku i odmítnutí serverem vnucených Read/Write/Skill,
i když shared settings povolují nástroje a mají skills/hooks/MCP. Normální-mode
pozitivní control nabízí nástroje a skutečně přečte syntetický povolený soubor.
Hooks zůstávají vypnuté a child MCP strict/prázdné; permissions/managed guardy
nejsou oslabeny. Není to OS sandbox ani garance nulových nativních filesystem I/O.

Smoke vytvoří vlastní malý temp cwd mimo repo a oddělený bridge state. Nezakládá
nový native auth profil: používá zvolený existující profil a normální preflight.
První zpráva žádá `ACK` a uložení náhodného syntetického markeru; po uzavření a
restartu MCP ověří přesný cached replay a druhou zprávou vyvolá marker. Kontroluje
v2 session/runtime/model identitu, neprázdné strukturované `model_evidence`, nula
permission denials, tahy 1/2 a uložené `policy.disableTools=true`. Sebepopis není
důkaz. Chybějící/změněná evidence selže, nikoli automatický fallback nebo retry.

**Spotřeba reálného tarifu/usage, možné náklady a zachované native transcripty.**
Globální nativní instrukce mohou stále platit; tiny cwd neslibuje doslova nulový
jiný context. Script je nemaže ani neodstraňuje permissions/settings. Úspěch po
uzavření obou MCP klientů uklidí pouze vlastní cwd/bridge state. Chyba zachová
adresář uvedený jako `retained_smoke_directory`; `task_submitted: "unknown"`
konzervativně nevylučuje provedenou inference. Zkontroluj stav i nativní transcript
před dalším rozhodnutím. Script neprovádí login/refresh ani automatickou obnovu.

Live smoke při této implementaci **nebyl spuštěn**. Privátní offline MCP a skutečný
native loopback rehearsal nejsou důkaz živého přístupu k modelu. Žádný unit/native
CI test nesmí volat živou cestu s reálným profilem; pro ni je nutný zvláštní souhlas.

## Odinstalace

Pouze po samostatném rozhodnutí na správném PC/rodičovském rootu:

```powershell
claude mcp remove claude_bridge --scope user
# Jen pokud je instalován i Codex cíl:
codex mcp remove claude_bridge
```

Poté řeš jen vlastní `claude-peer` discovery adresáře a nainstalovaný server.
Stav, zálohy a native transcripty ponech, potřebuješ-li kontinuitu/recovery.
Nemaž celé user profily ani nesouvisející MCP/skills. Restartuj rodiče.
