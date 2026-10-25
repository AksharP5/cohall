const help = `Cohall connects agents running on your own devices.

Usage:
  cohall onboard
  cohall init [--relay url] [--workspace path] [--providers list] [--service]
  cohall join --relay <url> --workspace <path> [--providers list] [--token-file <path>]
  cohall configure [--relay url] [--name name] [--description text] [--workspace path]
                   [--providers codex,opencode|auto] [--model id]
                   [--grok-gateway path]
  cohall config
  cohall devices [--watch [--interval seconds]]
  cohall progress [task-id] --message <note>
  cohall request-input [task-id] --question <text> [--run-id uuid]
  cohall answer <task-id> --request-id uuid --message <text>
  cohall bots
  cohall send [@device-or-bot] [prompt] [delegate options]
  cohall delegate [prompt] [--target @device-or-bot] [--provider provider]
                  [--context text] [--thread uuid] [--parent task-id] [--workspace path]
                  [--attach path] [--request-id uuid] [--timeout seconds] [--deadline UTC-timestamp] [--no-wait]
  cohall status <task-id>
  cohall inbox [ack <task-id>]
  cohall trace <task-id> [--follow]
  cohall wait <task-id> [--timeout seconds]
  cohall attachments <task-id>
  cohall download <task-id> <name> --output path [--direction input|output]
  cohall cancel <task-id>
  cohall reply <task-id> [--run-id uuid] --message-file path | --message text | --message - | --error text | --question text
  cohall thread <thread-id>
  cohall pair [--label name] [--client-only]
  cohall sessions
  cohall revoke <session-id>
  cohall forget <device-id>
  cohall doctor [--all]
  cohall versions
  cohall usage
  cohall upgrade [--to version|latest] [--no-restart] [--dry-run]
  cohall upgrade --all [--to version|latest] [--no-restart] [--dry-run]
  cohall upgrades [abandon <operation-id>]
  cohall service install
  cohall device
  cohall relay
  cohall relay backup <directory>
  cohall relay restore <directory>
  cohall relay use <url> [--no-restart] [--allow-http]
  cohall mcp
  cohall skill [install [agents|claude|opencode|all]]
  cohall integrations

Providers: codex, claude-code, opencode, grok-bot.
Configuration is stored per user; environment variables override it.`

export const printHelp = (): void => console.log(help)
