# Command Line Tool (CLI)

Saiye comes with a simple CLI for those users who want to do more advanced manipulation.

## Features

- Manipulate bookmarks, lists and tags
- Mass import/export of bookmarks

## Installation (NPM)

```
npm install -g @saiye/cli
```


## Installation (Docker)

```
docker run --rm ghcr.io/adrenalineinmyveins/karakeep-cli:release --help
```

## Usage

```
saiye
```

```
Usage: saiye [options] [command]

A CLI interface to interact with the saiye api

Options:
  --api-key <key>       the API key to interact with the API (env: SAIYE_API_KEY)
  --server-addr <addr>  the address of the server to connect to (env: SAIYE_SERVER_ADDR)
  --json                to output the result as JSON
  -V, --version         output the version number
  -h, --help            display help for command

Commands:
  auth                  authentication commands
  bookmarks             manipulating bookmarks
  lists                 manipulating lists
  tags                  manipulating tags
  whoami                returns info about the owner of this API key
  help [command]        display help for command
```

And some of the subcommands:

```
saiye bookmarks
```

```
Usage: saiye bookmarks [options] [command]

Manipulating bookmarks

Options:
  -h, --help             display help for command

Commands:
  add [options]          creates a new bookmark
  get <id>               fetch information about a bookmark
  update [options] <id>  updates bookmark
  list [options]         list all bookmarks
  delete <id>            delete a bookmark
  help [command]         display help for command

```

```
saiye lists
```

```
Usage: saiye lists [options] [command]

Manipulating lists

Options:
  -h, --help                 display help for command

Commands:
  list                       lists all lists
  delete <id>                deletes a list
  add-bookmark [options]     add a bookmark to list
  remove-bookmark [options]  remove a bookmark from list
  help [command]             display help for command
```

## Obtaining an API Key

To use the CLI, you'll need to get an API key from your saiye settings. You can validate that it's working by running:

```
saiye --api-key <key> --server-addr <addr> whoami
```

For example:

```
saiye --api-key mysupersecretkey --server-addr https://try.karakeep.app whoami
{
  id: 'j29gnbzxxd01q74j2lu88tnb',
  name: 'Test User',
  email: 'test@gmail.com'
}
```

You can also store the server address and API key in
`$XDG_CONFIG_HOME/saiye/config.json`. If `XDG_CONFIG_HOME` is not set, the
CLI reads `~/.config/saiye/config.json`.

```json
{
  "serverAddr": "https://try.karakeep.app",
  "apiKey": "mysupersecretkey"
}
```

Command-line options take precedence over environment variables, and
environment variables take precedence over the config file.
If no server address is provided, the CLI defaults to
`https://cloud.karakeep.app`.

To create or update this file interactively, run:

```bash
saiye auth init
```


## Other clients

There also exists a **non-official**, community-maintained, python package called [saiye-python-api](https://github.com/thiswillbeyourgithub/saiye_python_api) that can be accessed from the CLI, but is **not** official.
