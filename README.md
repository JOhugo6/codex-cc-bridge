**Česky** | [English](README.en.md)

# codex-cc-bridge

Sdílený **externí Claude Code peer** pro Claude Code / Claudex a volitelně Codex.
Skill `claude-peer` vysvětluje rodiči použití stdio MCP serveru `claude_bridge`
s nástroji `claude_turn` a `claude_status`. Každá konverzace má vlastní trvalou
nativní Claude session. Nejde o rodičovský nástroj **Agent**, `spawn_agent` ani
Agent Teams; změna provideru rodiče nezmění jeho nativní agenty na Anthropic.

Cesta je rodič → skill/MCP nástroj → lokální Node server → hlídaný `claude.exe`
→ uložené first-party přihlášení. Text jde přes UTF-8 stdin, první tah
použije `--session-id`, další `--resume`. Úlohy běží s `bypassPermissions`,
plnými nativními nástroji a MCP servery/hooks z nativního Claude profilu.
MCP konfigurace pouze v Codexu se automaticky nepřenáší.

**Omezení vydání:** historická občasná odmítnutí `NATIVE_DRIFT` před spuštěním
nemají prokázanou příčinu (reliability 47). Pozdější zelené běhy problém neuzavřely.
Finální release vyžaduje výslovné rozhodnutí a nezávislou závěrečnou revizi/testy.
Podrobnosti v [runbooku](docs/runbook.md#reliability-47).

## Podporované prostředí

- Windows a Node.js **20+**; testovací matice **20.20.0 / 24.12.0**.
- Instalátor: Windows PowerShell **5.1** nebo PowerShell **7**. Nativní supervisor
  potřebuje Windows PowerShell 5.1. Úplné testy vyžadují **oba** shelly a C# compiler
  z .NET Frameworku.
- Skutečný nativní **Claude Code > 2.1.263**, při instalaci `claude.exe` v PATH.
  Verze se porovnávají číselně; starší verze, 2.1.263 a prerelease se odmítají.
  Novější verze musí projít i kontrolou CLI, přihlášení a politik účtu. Shellové shimy
  a nativní inference mimo Windows nejsou podporované.
- Existující **uložené Pro/Max nebo Team first-party claude.ai přihlášení** na daném PC.
  Team používá stejné přihlášení jako Claude a musí projít kontrolou organizačních
  politik. Gateway, Enterprise, neznámé typy účtů, API key a OAuth předané prostředím
  nejsou podporované. Bridge nekopíruje přihlašovací údaje a nečte `.credentials.json`.
  Globální `.claude.json` interně porovnává podle chráněného obsahu; povolené
  provozní zápisy ostatních relací toleruje. Obsah souboru ani jeho otisk nezveřejňuje.
- Codex CLI jen pro registraci `-Target Codex` / `Both`. Pro `-Target Claude`
  a `-SkipRegister` není potřeba.

Metadata přihlášení nejsou důkaz platnosti tokenu nebo přístupu k Opusu. Testy ani
výchozí doctor neprovádějí login, refresh, instalaci do skutečného user profilu
nebo živý smoke.

## Instalace na každém PC

Spusť pouze tehdy, chceš-li změnit user-scope registraci a skill na tomto PC.
Instalátor stahuje uzamčené npm závislosti; před volbou oprávnění zkontroluj místní
permission policy.

```powershell
git clone https://github.com/JOhugo6/codex-cc-bridge.git
cd codex-cc-bridge
.\install.ps1 -Target Claude
```

Vznikne **jedna sdílená rodičovská registrace** `claude_bridge` přes nativní
`claude mcp add-json ... --scope user`. Claude/Claudex ji objevují v `.claude.json`,
**nikoli** v `settings.json`; musí používat stejný rodičovský config/discovery root.
Skill je v `~/.claude/skills/claude-peer`, případně v rodičovském
`CLAUDE_CONFIG_DIR/skills`. `-ClaudeSkillRoot` určuje jiný společný skill adresář.
Restartuj rodiče a požádej ho o použití **claude-peer** pro ohraničený úkol. Pokud
nástroj chybí, nenahrazuj jej rekurzivním spuštěním bridge/shellu.

Kompatibilní výchozí cíl zůstává `-Target Codex`. `-Target Both` přidá také Codex
registraci a totožný skill v `~/.agents/skills/claude-peer` (změna přes `-SkillRoot`).
Shodné cílové cesty skillů se deduplikují. Server i pro Claude-only zůstává v
`~/.codex/bridges/claude-bridge`, stav v `~/.codex/state/claude-bridge`;
`CODEX_HOME` / `-CodexRoot` mění společný základ.

```powershell
# Volitelný existující absolutní NFC profil dítěte; zachovej přesné znění cesty.
.\install.ps1 -Target Claude -NativeConfigRoot 'D:/Native Claude Profile'
# Volitelný Codex a výslovně přidaná oprávnění pro implementaci:
.\install.ps1 -Target Both -PermissionMode acceptEdits -AllowedTools 'Bash(npm test)'
```

Bez `-NativeConfigRoot` dítě používá standardní `~/.claude`, **nikoli rodičovské
`CLAUDE_CONFIG_DIR`**. Explicitní profil se uloží do `CLAUDE_BRIDGE_CONFIG_DIR`;
přijatý řetězec cesty a auth namespace se zachovají přesně. Ne-NFC filesystem
profil nebo nepodporovaná nepřímá cesta se odmítne. Mezi PC nepřenášej credentials,
nativní sessions ani absolutní MCP registraci; instaluj a přihlašuj se samostatně.

`-SkipRegister` stále kopíruje server/skills, spouští npm a neinferenční doctor;
**není to dry run**. Aktualizace chrání spravované soubory/registrace a ponechává
úzké zálohy. Kolize odmítne. Neúplný rollback zachová souběžné zápisy a recovery
zálohu; neobnovuj celý starý config přes aktuální data.

## Model, oprávnění a kontinuita

Veřejné **`opus` → `claude-opus-5[1m]`**, strukturované/wire základní ID je
`claude-opus-5`. Zmrazený katalog obsahuje jen `opus`, `opus[1m]`, `claude-opus-5`,
`claude-opus-5[1m]`. Explicitní `model` nástroje má u nové konverzace přednost před
`CLAUDE_BRIDGE_MODEL`. Žádné převzetí rodičovského aliasu, automatický fallback
provideru/modelu nebo tichá náhradní session.

Stav v2 připíná model, účet, runtime, profil a pracovní adresář. Nový tah
normalizuje i historickou bridge policy na `bypassPermissions`,
`allowedTools=[]`, `disableTools=false`; completed replay zachovává původní data.
Před odesláním se nová policy uloží s pending stavem, při selhání před odesláním
se obnoví původní ready stav. V1 dovoluje pouze status a completed replay.

Staré `CLAUDE_BRIDGE_PERMISSION_MODE`, `CLAUDE_BRIDGE_ALLOWED_TOOLS` a
`CLAUDE_BRIDGE_DISABLE_TOOLS` se validují kvůli kompatibilitě, ale neomezují úlohy.
Bridge nepředává `--tools`, `--allowedTools` ani prázdnou MCP konfiguraci a
nevypíná hooks. Metadata diagnostika je oddělená: nespouští MCP ani hooks.
Nativní managed/OS omezení a explicitní nativní deny pravidla zůstávají v platnosti.
Kontroluj `permission_denials`. Bridge nezakazuje rekurzivní delegování;
existující zámky souběžných session/profilu stále platí. Ověřování identity/modelu/first-party
routingu zůstává zachované; nejde o OS sandbox.

```json
{
  "conversation_id": "project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/Projects/My App",
  "message": "Zkontroluj autentizaci. Vrať konkrétní nálezy; neupravuj soubory."
}
```

Zachovej conversation ID, pro další zprávu dej nové request ID. Stejné dokončené
request ID se stejnou zprávou vrátí přesný cached výsledek (kromě `replayed: true`)
bez nativního preflightu či inference. Výsledek obsahuje `reply`, `session_id`,
`turn`, `model`, `runtime`, `model_evidence`, usage/cost a denials. Prázdné
`model_evidence` model nedokládá; sebepopis modelu není důkaz.

Preflight je **před** uložením `pending`; finální recheck bezprostředně před
hlídaným spawnem. Prokazatelně předspouštěcí odmítnutí obnoví předchozí `ready`
snapshot (při selhání obnovy zůstane konzervativní `pending`). Selhání po submission
callbacku je `uncertain`. Použij `claude_status`, automaticky neopakuj úlohu,
nemaž stav a nezakládej náhradní konverzaci. Bridge stav i lokální nativní
transcripty jsou nutné pro kontinuitu a mohou obsahovat citlivá zadání/výsledky.
Timeout je 900 s, Codex má 60 s navíc; Windows Job supervisor zajišťuje úklid
podřízeného procesu a potomků při timeoutu/odpojení.

## Diagnostika a testy

```powershell
npm.cmd --prefix bridge ci --ignore-scripts --no-audit --no-fund
npm.cmd --prefix bridge run doctor
# Výslovný metadata/preflight, nikoli inference; možný kontakt ancillary služeb:
npm.cmd --prefix bridge run doctor -- --native --cwd 'C:/Projects/My App' --model opus
# Skutečný pinovaný executable; testy pouze syntetické profily + loopback/deny proxy:
$env:NATIVE_CONTRACT_CLAUDE_EXE = (Get-Command claude.exe -CommandType Application | Select-Object -First 1).Source
npm.cmd --prefix bridge test
```

Výchozí doctor ověřuje handshake a očekávaná **veřejná schémata nástrojů** s
omezeným čekáním; nespouští nativní CLI/auth/model. `--native` používá zmrazenou
runtime validaci a vypisuje sanitizovaná metadata kompatibility/profilu, nikoli
certifikaci tokenu/entitlementu. Nevypisuje raw auth JSON ani prostředí.

`npm test` explicitně zahrnuje všechny udržované offline suites včetně nativní
charakterizace/integrace a instalátoru, bez shell globů a živého smoke.
`test:unit`, `test:native`, `test:installer` jsou dílčí skupiny. Chybějící native/
Windows/PowerShell předpoklady znamenají selhání, nikoli úspěšné přeskočení.
Syntetický transport není live entitlement důkaz ani OS sandbox. Soubory suites
běží sekvenčně; záměrné souběžné scénáře zůstávají uvnitř testů.

**Historický Node20 installer blocker:** dřívější fixture vytvořila hardlink
běžícího Node 20.20.0 a úklid selhal s `EPERM`; tento aggregate nebyl PASS. Opravu
a nezávislé kontroly vlastní balík B4. Dokud ji nepotvrdí závěrečný aggregate
aktuálních zdrojů, non-installer testy C2 nejsou plná Node20 kompatibilita.
Jde o jiný problém než neuzavřená reliability 47.

CI má Windows Node20/24 jobs a skutečný pinovaný native provisioning. Pomocník
`bridge/ci/provision-native.js` stáhne oficiální Windows x64 **2.1.268**, ověří
pevnou velikost/SHA256 před zpřístupněním executable a CI následně ověří verzi/flags
v disposable syntetickém profilu. Jen HTTPS, bez redirectů, latest, binárky z
repository variables nebo loginu. PR používá pomocník z **důvěryhodného base
commitu**, nikoli fork/head kód; pomocník musí nejprve existovat na base větvi.
Chybějící artefakt/síť/base helper gate odmítne, nejde o úspěšný skip.
[Provenience, checksum a setup](docs/runbook.md#native-ci-provisioning).
Lokální testy nebo vytvoření workflow neznamenají spuštění hosted CI.

`npm.cmd --prefix bridge run smoke -- --live` (nebo `CLAUDE_BRIDGE_LIVE=1`) je
použitelný živý check se **zvláštním opt-in**, není součást offline testů ani CI.
Bez opt-in vrátí `SMOKE_OPT_IN_REQUIRED` před vytvářením souborů a spuštěním MCP.
Se souhlasem použije Opus, `bypassPermissions`, plné nástroje, MCP a hooks
ze zvoleného profilu a malý dočasný cwd mimo repo. Odešle dvě syntetické zprávy přes restart MCP procesu,
ověří přesný cached replay, stabilní v2 session/runtime identitu a neprázdná
strukturovaná modelová metadata, nikoli sebepopis.

**Spotřebuje skutečné usage, může stát peníze a ponechá native transcripty ve
zvoleném existujícím profilu. Globální native instrukce mohou stále platit.**
Script neprovádí login, refresh, retry ani fallback. Úspěch uklidí jen jeho vlastní
cwd/bridge stav; chyba tento adresář zachová pro kontrolu. Nikdy nemaže nativní
profil/transcript. Offline actual-native kontroly vypnutých i běžných nástrojů
nejsou live entitlement důkaz. Živá cesta při této implementaci nebyla spuštěna;
před spuštěním je nutný samostatný souhlas.

[Provozní příručka](docs/runbook.md). Reference:
[Codex MCP](https://developers.openai.com/codex/mcp),
[Claude programmatic usage](https://code.claude.com/docs/en/headless).
Apache-2.0; původ Windows supervisoru uvádí [NOTICE](NOTICE).
