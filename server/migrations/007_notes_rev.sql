-- 007: 随手记（notes + cats）也加一个单调递增的版本号。
-- 服务器每接受一次 notes/cats 的写入就 +1，并唤醒在 GET /api/sync/notes?since=&wait=
-- 上等着的其它设备（长轮询），这样一台设备改完，别的设备约一秒内就能拉到，
-- 不用再靠每 20 秒的定时轮询。客户端推送时带上它读到的版本 notesBase 做
-- compare-and-swap：版本已经被别的设备推过去的就拒收，让客户端先拉再合并再推。
ALTER TABLE user_data ADD COLUMN IF NOT EXISTS notes_rev BIGINT NOT NULL DEFAULT 0;
