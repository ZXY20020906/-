-- 会话加固：设备绑定 + 闲置超时。
--   device_hash  登录时浏览器给的设备标识的 sha256；请求必须同时带上 folia_device Cookie
--   last_seen_at 最后一次活动时间，超过 IDLE 时间没动就得重新登录
--   wrangler d1 execute folia --file=./schema/009_session_device.sql --remote

ALTER TABLE sessions ADD COLUMN device_hash TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
