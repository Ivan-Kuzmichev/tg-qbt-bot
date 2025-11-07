# Telegram qBittorrent Bot

Этот бот позволяет добавлять торренты в **qBittorrent** через Telegram.  
Поддерживает magnet-ссылки, .torrent файлы, ссылки на .torrent и управление загрузкой через кнопки.
На данный момент из-за отличия API у разных тем, поддерживается только тема vuetorrent. 


## Пример конфигурации

```yaml
services:
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    network_mode: bridge
    ports:
      - "8787:8787"
      - "54890:54890" # Порт используемый для входящих соединений
    environment:
      - PUID=1026
      - PGID=101
      - TZ=Europe/Moscow
      - WEBUI_PORT=8787
      - TORRENTING_PORT=54890
      - DOCKER_MODS=ghcr.io/vuetorrent/vuetorrent-lsio-mod:latest # После установки прописать альтернативный WebUI: `/vuetorrent`
    volumes:
      - ./config:/config
      - /volume1/downloads:/downloads
    restart: unless-stopped

  bot:
    image: tg-qbt-bot:latest
    container_name: tg-qbt-bot
    environment:
      - TELEGRAM_TOKEN=XXXXX:XXXXX
      - QBT_HOST=http://192.168.1.50:8787 # URL qBittorrent
      - QBT_USERNAME=admin # Логин от qBittorrent
      - QBT_PASSWORD=admin # Пароль от qBittorrent
      - ALLOWED_USER_IDS=XXXXX,XXXXX # ID пользователей, которым доступен бот
    network_mode: bridge
    restart: unless-stopped
```
