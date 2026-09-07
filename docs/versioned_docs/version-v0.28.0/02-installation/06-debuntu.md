# Debian 12/Ubuntu 24.04

:::warning
This script is a stripped-down version of those found in the [Proxmox Community Scripts](https://github.com/community-scripts/ProxmoxVE) repo. It has been adapted to work on baremetal Debian 12 or Ubuntu 24.04 installs **only**. Any other use is not supported and you use this script at your own risk.
:::

### Requirements

- **Debian 12** (Buster) or
- **Ubuntu 24.04** (Noble Numbat)

The script will download and install all dependencies (except for Ollama), install Saiye, do a basic configuration of Saiye and Meilisearch (the search app used by Saiye), and create and enable the systemd service files needed to run Saiye on startup. Saiye and Meilisearch are run in the context of their low-privilege user environments for more security.

The script functions as an update script in addition to an installer. See **[Updating](#updating)**.

### 1. Download the script from the [Saiye repository](https://github.com/adrenalineinmyveins/karakeep/blob/main/saije-linux.sh)

```
wget https://raw.githubusercontent.com/adrenalineinmyveins/karakeep/main/saije-linux.sh
```

### 2. Run the script

> This script must be run as `root`, or as a user with `sudo` privileges.

    If this is a fresh install, then run the installer by using the following command:

    ```shell
    bash saije-linux.sh install
    ```

### 3. Create an account/sign in

    Then visit `http://localhost:3000` and you should be greated with the Sign In page.

## Updating

> This script must be run as `root`, or as a user with `sudo` privileges.

    If Saiye has previously been installed using this script, then run the updater like so:

    ```shell
     bash saije-linux.sh update
    ```

## Services and Ports

`saiye.target` includes 4 services: `meilisearch.service`, `saiye-web.service`, `saiye-workers.service`, `saiye-browser.service`.

- `meilisearch.service`: Provides full-text search, Saiye Workers service connects to it, uses port `7700` by default.

- `saiye-web.service`: Provides the saiye web service, uses `3000` port by default.

- `saiye-workers.service`: Provides the saiye workers service, no port.

- `saiye-browser.service`: Provides the headless browser service, uses `9222` port by default.

## Configuration, ENV file, database locations

During installation, the script created a configuration file for `meilisearch`, an `ENV` file for Saiye, and located config paths and database paths separate from the installation path of Saiye, so as to allow for easier updating. Their names/locations are as follows:

- `/etc/meilisearch.toml` - a basic configuration for meilisearch, that contains configs for the database location, disabling analytics, and using a master key, which prevents unauthorized connections.
- `/var/lib/meilisearch` - Meilisearch DB location.
- `/etc/saiye/saiye.env` - The Saiye `ENV` file. Edit this file to configure Saiye beyond the default. The web service and the workers service need to be restarted after editing this file:

    ```shell
    sudo systemctl restart saiye-workers saiye-web
    ```

- `/var/lib/saiye` - The Saiye database location. If you delete the contents of this folder you will lose all your data.

## Still Running Hoarder?

There is a way to upgrade. Please see [Guides > Hoarder to Saiye Migration](../14-guides/04-hoarder-to-karakeep-migration.md)
