# Arch Linux

## Installation

> [Saiye on AUR](https://aur.archlinux.org/packages/karakeep) is not maintained by the saiye official.

1. Install saiye

    ```shell
    paru -S karakeep
    ```

2. (**Optional**) Install optional dependencies

    ```shell
    # saiye-cli: saiye cli tool
    paru -S karakeep-cli

    # ollama: for automatic tagging
    sudo pacman -S ollama

    # yt-dlp: for download video
    sudo pacman -S yt-dlp
    ```

    You can use Open-AI instead of `ollama`. If you use `ollama`, you need to download the ollama model. Please refer to: [https://ollama.com/library](https://ollama.com/library).

3. Set up

    Environment variables can be set in `/etc/saiye/saiye.env` according to [configuration page](/configuration). **The environment variables that are not specified in `/etc/saiye/saiye.env` need to be added by yourself.**

4. Enable service

    ```shell
    sudo systemctl enable --now saiye.target
    ```

    Then visit `http://localhost:3000` and you should be greated with the sign in page.

## Services and Ports

`saiye.target` include 3 services: `saiye-web.service`, `saiye-works.service`, `saiye-browser.service`.

- `saiye-web.service`: Provide saiye webui service, uses `3000` port by default.

- `saiye-workers.service`: Provide saiye workers service, no port.

- `saiye-browser.service`: Provide browser headless service, uses `9222` port by default.

Now `saiye` depends on `meilisearch`, and `saiye-workers.service` wants `meilisearch.service`, starting `saiye.target` will start `meilisearch.service` at the same time.

## How to Migrate from Hoarder to Saiye

The PKGBUILD has been fully updated to replace all references to `hoarder` with `saiye`. If you want to preserve your existing `hoarder` data during the upgrade, please follow the steps below:

**1. Stop the old services**

```shell
sudo systemctl stop hoarder-web.service hoarder-worker.service hoarder-browser.service
sudo systemctl disable --now hoarder.target
```

**2. Uninstall Hoarder**  
After uninstalling, you can manually remove the old `hoarder` user and group if needed.
```shell
paru -R hoarder
```

**3. Rename the old data directory**
```shell
sudo mv /var/lib/hoarder /var/lib/saiye
```

**4. Install Saiye**
```shell
paru -S karakeep
```

**5. Fix ownership of the data directory**
```shell
sudo chown -R saiye:saiye /var/lib/saiye
```

**6. Set Saiye**  
Edit `/etc/saiye/saiye.env` according to [configuration page](/configuration). **The environment variables that are not specified in `/etc/saiye/saiye.env` need to be added by yourself.**

Or you can copy old hoarder env file to saiye:
```shell
sudo cp -f /etc/hoarder/hoarder.env /etc/saiye/saiye.env
```

**7. Start Saiye**
```shell
sudo systemctl enable --now saiye.target
```
