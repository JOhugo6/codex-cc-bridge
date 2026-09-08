**Česky** | [English](README.en.md)

# codex-cc-bridge

Volání **Claude Code CLI jako subagenta z Codexu**. Opačný směr k projektům
`cc-codex-bridge` a `cc-copilot-bridge`: Codex deleguje přímo přes MCP nástroj,
Claude má vlastní kontext a pracuje ve zvoleném adresáři projektu.

```text
Codex + skill claude-peer
  └─ claude_bridge / claude_turn
       └─ Node.js MCP server
            └─ claude --print --output-format json
                 ├─ první tah: --session-id <UUID>
                 └─ další tahy: --resume <stejné UUID>
```

Není potřeba Claude relay agent ani experimentální Agent Teams. MCP integrace
vychází z [dokumentace Codexu](https://developers.openai.com/codex/mcp), spouštění
CLI z [dokumentace Claude Code](https://code.claude.com/docs/en/headless).

## Požadavky

- Windows, Node.js 20+, Windows PowerShell 5.1 nebo PowerShell 7.
- Codex CLI v PATH; instalátor používá `codex mcp add`.
- Nativní `claude.exe` v PATH, funkční přihlášení přes `claude auth login`.
- Vývoj a lokální testy proběhly na Node 24.12.0, Codex CLI 0.153.4 a Claude Code 2.1.126.

Windows je ověřovaná platforma. Backend obsahuje i POSIX větev, ale instalátor
a garance úklidu odpojených procesů jsou určeny pro Windows.

## Instalace

```powershell
git clone https://github.com/JOhugo6/codex-cc-bridge.git
cd codex-cc-bridge
.\install.ps1
```

Instalátor zkopíruje server do `~/.codex/bridges/claude-bridge`, spustí `npm ci`,
ověří MCP handshake bez modelového volání, přidá skill do `~/.agents/skills/claude-peer`
a zaregistruje server `claude_bridge` v konfiguraci Codexu. Před úpravou existujícího
`config.toml` vytvoří zálohu. Respektuje `CODEX_HOME`; cíle lze změnit parametry
`-CodexRoot` a `-SkillRoot`. Původní bridge pro Claude Code se neupravují.

Potom **restartuj Codex** a zadej například:

```text
$claude-peer Pošli Claude úkol zkontrolovat autentizaci v aktuálním projektu.
Chci konkrétní chyby s odkazy na soubory, bez úprav kódu.
```

Nebo: „Použij Claude jako subagenta pro návrh testů tohoto modulu.“ Skill
vysvětluje Codexu nástroj, zachování kontextu a zpracování přerušených tahů.
Jde o externího subagenta přes MCP, nikoli nativní roli nástroje `spawn_agent`.

## Oprávnění a úpravy kódu

Výchozí režim je `dontAsk`: Claude nečeká na interaktivní potvrzení a nepovolené
operace odmítne. Stále platí existující Claude permission rules; nejde o sandbox
ani záruku pouze čtení. Zamítnuté nástroje jsou vráceny v `permission_denials`.

Pro práci na implementaci můžeš při instalaci povolit editace a konkrétní příkazy:

```powershell
.\install.ps1 -PermissionMode acceptEdits -AllowedTools 'Bash(npm test)'
```

Model se ve výchozím nastavení přebírá z Claude CLI. Volitelně lze použít
`-Model sonnet` nebo zadat `model` v prvním volání nástroje.
Oprávnění nastavená bridgem, model a adresář jsou uložené při vzniku konverzace;
nové nastavení instalátoru platí pro **nové conversation ID**. Claude settings
a jejich vlastní permission rules se dál načítají při každém spuštění.

Pro podřízené Claude jsou vypnuté hooks a načítání MCP serverů (`--strict-mcp-config`
s prázdnou konfigurací), aby se nespouštěly uživatelské hooky a další bridge.
Claude dál načítá projektový kontext a `CLAUDE.md`. Zadání jde jako UTF-8 přes
stdin, bez vložení textu do příkazové řádky nebo shellu.

## Přímé MCP volání

```json
{
  "conversation_id": "my-project-review-01",
  "request_id": "turn-01",
  "working_dir": "C:/vyvoj/my-project",
  "message": "Zkontroluj implementaci autentizace. Vrať nálezy s cestami a řádky."
}
```

Další zpráva použije stejné `conversation_id`, nové `request_id` a může vynechat
adresář. Změna adresáře nebo explicitního modelu v téže konverzaci je chyba.
ID rozlišují velikost písmen i na Windows; stavové soubory používají SHA-256 názvy.
Konverzační klíče jsou společné pro celý stavový adresář, proto do nich zahrň projekt.

Výsledek obsahuje `reply`, `session_id`, `turn`, `working_dir`, `replayed`,
`permission_denials`, `usage` a `total_cost_usd`. Text odpovědi je zachovaný
v poli `reply` strukturovaného MCP výsledku i v JSON textového bloku.
`claude_status({conversation_id})` vrátí stav a poslední dokončený výsledek bez volání modelu.

`request_id` je volitelný, ale doporučený: stejné ID a stejná zpráva po dokončení
vrátí uložený výsledek, bez dalšího volání Claude. Jiné tělo se stejným ID je chyba.
Bez request ID každý úspěšný požadavek znamená nový tah.

## Stav a chyby

Bridge ukládá UUID, adresář, konfiguraci a výsledky do
`~/.codex/state/claude-bridge/<sha256>.json`. Claude ukládá vlastní historii
do svého standardního úložiště. Pro kontinuitu jsou potřeba **obě úložiště**.

- Při chybě obnovy se nikdy automaticky nezaloží nová session.
- Před spuštěním je na disk uložen stav `pending`. Po úspěchu přejde do `ready`;
  při chybě do `uncertain`. Přerušené tahy se automaticky neopakují.
- Souběžný požadavek na stejnou konverzaci dostane `CONVERSATION_BUSY`.
- Na Windows běží Claude v Job Objectu. Timeout, zrušení i smrt MCP serveru
  ukončí podřízený proces a jeho potomky.
- Timeout CLI je 900 sekund; instalátor nastaví MCP timeout o 60 sekund delší.

Obnova po chybě, proměnné prostředí a odinstalace: [provozní příručka](docs/runbook.md).

## Testy

```powershell
npm.cmd --prefix bridge ci
npm.cmd --prefix bridge test
npm.cmd --prefix bridge run doctor

# Dvě skutečná modelová volání, oddělené procesy MCP a ověření paměti:
$env:CLAUDE_BRIDGE_LIVE = '1'
npm.cmd --prefix bridge run smoke
```

Automatické testy bez modelu pokrývají subprocess komunikaci, vícekolový kontext,
MCP restart, opakované požadavky, pracovní adresář, korupci stavu, timeout,
zrušení, zamítnuté operace a Windows process tree. Živý test používá dočasný
pracovní adresář; vlastní Claude transcript zůstává ve standardním Claude úložišti.

## Licence

Apache-2.0. Windows Job Object supervisor je převzatý a upravený z
`cc-codex-bridge`; původ a změny jsou uvedené v [NOTICE](NOTICE).
