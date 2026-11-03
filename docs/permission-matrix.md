# 权限矩阵

规则只有一处：`src/core/permissions.js`。路由层用 `assertCan(actor, ACTION.X, resource)`，前端用 `/api/auth/me` 返回的 `capabilities` 决定按钮显隐。两边不会漂移，因为 `matrix()` 和测试共用同一份数据。

## 角色

| 角色 | 标识 | 说明 |
|---|---|---|
| 管理员 | `admin` | 全站管理：发布、删除、分类、成员、审计 |
| 编辑 | `editor` | 上传与维护自己的草稿，可选择已有分类 |

没有第三种角色，也没有"只读访客"账号——访客走公开只读接口 `/api/public/*`，不需要登录。

## 动作 × 角色

| 动作 | 常量 | admin | editor |
|---|---|:--:|:--:|
| 读壁纸列表 | `wallpaper:read` | ✅ | ✅ |
| 新建壁纸（草稿） | `wallpaper:create` | ✅ | ✅ |
| 上传文件 | `asset:upload` | ✅ | ✅ |
| 改壁纸 | `wallpaper:update` | ✅ 任意 | ✅ 仅自己的 |
| 发布 / 下线 | `wallpaper:publish` | ✅ | ❌ |
| 删除壁纸 | `wallpaper:delete` | ✅ | ❌ |
| 壁纸重排 | `wallpaper:reorder` | ✅ | ❌ |
| 读分类 | `category:read` | ✅ | ✅ |
| 新建分类 | `category:create` | ✅ | ❌ |
| 改分类 | `category:update` | ✅ | ❌ |
| 删分类 | `category:delete` | ✅ | ❌ |
| 分类重排 | `category:reorder` | ✅ | ❌ |
| 成员管理 | `member:manage` | ✅ | ❌ |
| 审计日志 | `audit:read` | ✅ | ❌ |

## 归属规则

`wallpaper:update` 是唯一带归属判断的动作：

```
admin  → 拥有 wallpaper:update:any，可以改任何一条
editor → 拥有 wallpaper:update:own，仅当 row.created_by === actor.id
```

`created_by` 为 `NULL` 的历史数据（比如从旧站迁移进来但没标作者），编辑不能改，管理员可以。迁移时建议指定 `created_by` 给某位管理员，避免出现"没人能改"的孤儿数据。

## 三条硬性保护

1. 不能改自己的角色，不能停用自己（`src/server/routes/members.js`）——防止误操作把自己降级。
2. 全站至少保留一位启用状态的管理员；降级/停用最后一位会被 409 拒绝。
3. 重置某成员密码后，该成员所有会话立即失效。

## 想改规则？改这里

**让编辑也能直接发布**（适合几个人都可信的小团队）：

```js
// src/core/permissions.js
const EDITOR_CAPS = Object.freeze([
  ACTION.WALLPAPER_READ,
  ACTION.WALLPAPER_CREATE,
  ACTION.WALLPAPER_UPDATE,
  CAP.UPDATE_OWN,
  ACTION.ASSET_UPLOAD,
  ACTION.CATEGORY_READ,
  ACTION.WALLPAPER_PUBLISH,   // ← 加这一行
]);
```

**让编辑也能删自己的壁纸**：需要给权限模块增加一个 `DELETE_OWN` 分支，并在 `remove()` 里传 `resource`。这属于结构性改动，先把测试（`tests/permissions.test.js`）改成你期望的行为再动实现。

**增加第三种角色**（比如"审核员"只能发布不能删）：加进 `ROLE`、`ROLES`、`ROLE_CAPABILITIES`，`users.role` 的 CHECK 约束也要改（D1 需要重建表或新加列）。
