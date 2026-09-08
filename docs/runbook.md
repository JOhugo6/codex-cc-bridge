# Provoz a diagnostika

## Kontrola instalace

```powershell
codex mcp get claude_bridge
node "$env:USERPROFILE\.codex\bridges\claude-bridge\doctor.js"
claude --version
claude auth status
```

Doctor ověří server a seznam nástrojů bez modelového volání. `auth status` může
hlásit přihlášení i u prošlého tokenu; rozhodující je skutečné modelové volání.
Při `401 / OAuth access token has expired` proveď `claude auth login`.

Test v izolovaných cestách, bez změny běžné konfigurace:

```powershell
.\install.ps1 -CodexRoot C:/Temp/bridge-test/codex -SkillRoot C:/Temp/bridge-test/skills
```

`-SkipRegister` pouze zkopíruje server a skill a ověří handshake. Pro aktualizaci
zopakuj instalátor se zvoleným modelem, oprávněními a timeoutem; bez parametrů
se použijí výchozí hodnoty. Potom restartuj Codex. Stavové soubory se nepřepisují.

## Konfigurace serveru

| Proměnná | Význam / výchozí hodnota |
|---|---|
| `CLAUDE_BRIDGE_COMMAND` | Nativní CLI; na Windows instalátor uloží absolutní cestu `claude.exe`. Shellové shimy `.cmd`, `.bat`, `.ps1` nejsou podporované. |
| `CLAUDE_BRIDGE_STATE_DIR` | Absolutní cesta k bridge stavu, standardně `$CODEX_HOME/state/claude-bridge` nebo `~/.codex/state/claude-bridge`. |
| `CLAUDE_BRIDGE_TIMEOUT_MS` | Timeout celého subprocessu včetně spuštění, 900000 ms. |
| `CLAUDE_BRIDGE_PERMISSION_MODE` | `dontAsk`; dále `acceptEdits`, `plan`, `default`, `auto`. |
| `CLAUDE_BRIDGE_ALLOWED_TOOLS` | JSON pole Claude permission pravidel, výchozí `[]`. |
| `CLAUDE_BRIDGE_MODEL` | Volitelný výchozí model, jinak nastavení Claude CLI. |

Bridge dědí přihlášení a prostředí CLI. Nepodporuje
`CLAUDE_CODE_SKIP_PROMPT_HISTORY`, protože potřebuje uloženou session.
Model a explicitní režim/povolené nástroje se persistují při prvním tahu;
ostatní Claude nastavení se načítají znovu. Změna těchto uložených parametrů
se projeví až s novým conversation ID.

Při ruční registraci nastav v `[mcp_servers.claude_bridge]` také
`startup_timeout_sec = 30` a `tool_timeout_sec = 960`. Výchozí MCP timeout
Codexu je kratší než běžný agentní úkol; viz [oficiální konfigurace](https://developers.openai.com/codex/mcp).

## Přerušený tah

1. Zavolej `claude_status` se stejným `conversation_id`.
2. U `ready` lze vyzvednout `last_result`, případně zopakovat stejný dokončený
   požadavek se stejným `request_id`. Opakování nepřidá tah.
3. `pending` nebo `uncertain` znamená, že výsledek není bezpečně potvrzený.
   Prohlédni změny v pracovním adresáři a Claude transcript pro uvedené `session_id`.
   Neopakuj automaticky požadavek a nemaž stav.
4. Po kontrole může operátor vědomě založit nové conversation ID a předat mu
   potřebný kontext. To je nová session, nikoli obnova původní historie.

Bridge neposkytuje automatickou opravu rozpracované session, protože samotná
existence Claude transcriptu neprokazuje dokončení změn. Pro ruční pokračování
v původní session můžeš v uloženém pracovním adresáři použít
`claude --resume <session_id>`; současně ji nepoužívej přes bridge.

## Zámky a poškozený stav

Zámek `<sha256>.json.lock` obsahuje PID, hostname a čas. Automaticky se nepřebírá,
ani po uplynutí času: živý agent nesmí být omylem spuštěný dvakrát.
Při `CONVERSATION_BUSY` počkej na aktivní tah. Po pádu nejdřív ověř, že původní
MCP server a jeho podřízený proces skončily; poté lze odstranit **jen konkrétní
osiřelý lock soubor**. Stav `pending/uncertain` tím nezmizí a dál brání opakování.

Poškozený JSON nebo neplatná identita znamená `CORRUPT_STATE`. Obnov ověřenou
zálohu obou úložišť nebo vědomě začni novou konverzaci. Bridge nepovažuje
poškozený soubor za prázdnou historii. Ztrátu celého bridge souboru nelze odlišit
od dosud nepoužitého conversation ID; proto stav nemaž jako cache.

Stavové soubory obsahují odpovědi a cache dokončených request ID; jejich velikost
roste s konverzací. Neobsahují kopii přihlašovacích tokenů. Claude transcript
obsahuje vlastní zadání a výsledky. Windows používá zděděná ACL adresáře;
úložiště nesdílej s nedůvěryhodnými uživateli. Atomic rename a flush chrání
proti běžnému pádu procesu; nejde o transakční garanci při výpadku disku/napájení.

## Odinstalace

```powershell
codex mcp remove claude_bridge
```

Potom odstraň pouze instalovaný adresář `claude-peer` ze svého skill adresáře
a `claude-bridge` z `~/.codex/bridges`. Historii v `state/claude-bridge` a nativní
Claude sessions ponech, pokud chceš zachovat možnost návratu. Restartuj Codex.
