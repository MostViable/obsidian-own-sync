# Установка тестового сервера на VPS

Эта инструкция предназначена для внутреннего MVP и тестовых vault. Сервер и ожидающие пакеты пока не шифруют содержимое; не используйте их для настоящих заметок.

## Установка бинарника

Скачайте архив для архитектуры VPS из GitHub Releases (`x86_64-unknown-linux-gnu` или `aarch64-unknown-linux-gnu`) и распакуйте его:

```bash
sudo install -d -o root -g root -m 755 /opt/own-sync
sudo tar -xzf own-sync-server-<target>.tar.gz -C /opt/own-sync --strip-components=1 \
  own-sync-server-<target>/own-sync-server
sudo install -d -o root -g root -m 755 /var/lib/own-sync
sudo useradd --system --home-dir /var/lib/own-sync --shell /usr/sbin/nologin own-sync
sudo install -d -o own-sync -g own-sync -m 700 /var/lib/own-sync/data
```

Если пользователь уже существует, команда `useradd` вернёт ошибку; продолжайте с созданием каталога. Проверьте архитектуру до скачивания командой `uname -m`: `x86_64` соответствует x86-64, `aarch64` — ARM64.

Установите unit-файл из архива и запустите сервер:

```bash
sudo install -o root -g root -m 644 own-sync.service /etc/systemd/system/own-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now own-sync
curl --fail http://127.0.0.1:8787/healthz
```

Ответ health check должен быть `{"status":"ok"}`. Логи доступны через `journalctl -u own-sync`.

## HTTPS через Caddy

Направьте DNS `sync.example.com` на VPS и установите Caddy из официального репозитория. Добавьте блок из `Caddyfile.example` в `/etc/caddy/Caddyfile`, заменив домен:

```caddyfile
sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Перезагрузите конфигурацию и проверьте HTTPS:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://sync.example.com/healthz
```

Не открывайте порт `8787` в firewall: unit слушает только loopback, наружу доступен Caddy на 443.

## Первый vault и отдельные устройства

Создайте закрытый каталог и выполните `bootstrap` от пользователя сервера или администратора:

```bash
sudo install -d -o own-sync -g own-sync -m 700 /var/lib/own-sync/credentials
sudo -u own-sync /opt/own-sync/own-sync-server bootstrap \
  /var/lib/own-sync/data/sync.sqlite \
  /var/lib/own-sync/credentials/owner.json
sudo -u own-sync /opt/own-sync/own-sync-server provision \
  /var/lib/own-sync/data/sync.sqlite \
  /var/lib/own-sync/credentials/owner.json \
  /var/lib/own-sync/credentials/phone.json
```

Передайте на устройства только соответствующий JSON-файл по защищённому каналу. Скопируйте `vault_id` и сохраните `token` в Obsidian SecretStorage; токен не вставляйте в URL, shell history или Git. Плагин и порядок первой синхронизации описаны в [BOOTSTRAP.md](BOOTSTRAP.md).

## Резервная копия и восстановление

Создавайте копии в закрытом каталоге, которого нет в web root:

```bash
sudo install -d -o own-sync -g own-sync -m 700 /var/lib/own-sync/backups
sudo -u own-sync /opt/own-sync/own-sync-server backup \
  /var/lib/own-sync/data/sync.sqlite \
  /var/lib/own-sync/backups/sync-$(date +%Y%m%d-%H%M%S).sqlite
```

Для проверки восстановления остановите тестовый unit, замените **только на копии** путь `OWN_SYNC_DB` на восстановленный файл и выполните `Check vault access`. Команда `backup` не перезаписывает существующий путь; храните несколько копий и регулярно проверяйте одну на отдельной чистой машине.
