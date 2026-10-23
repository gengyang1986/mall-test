/**
 * mall-portal 下单主链路 step 定义（playwright-bdd）
 *
 * 依赖：@playwright/test、playwright-bdd、mysql2
 * 环境变量：
 *   PORTAL_BASE_URL          默认 http://localhost:8085
 *   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 *                            默认 127.0.0.1 / 3306 / root / root / mall
 *
 * 约定：
 *   1) 业务结果以响应体 code 判定，HTTP 状态恒为 200；仅未捕获异常时才出现 5xx
 *   2) 库存、订单状态、支付时间等内部状态通过 MySQL 直接断言（后置条件校验），不改变被测行为
 *   3) 所有写操作都基于测试会员 malltest01 / mallbdd02，运行前请确保是独立测试库
 */
import { expect, test } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import mysql from 'mysql2/promise';

const { Given, When, Then } = createBdd(test);

const BASE = process.env.PORTAL_BASE_URL ?? 'http://localhost:8085';
const PASSWORD = 'P@ssw0rd';
const MAIN_MEMBER = { username: 'malltest01', telephone: '13800000001' };
const OTHER_MEMBER = { username: 'mallbdd02', telephone: '13900000003' };
const DEFAULT_SKU = 10001;

type ApiResult = { status: number; body: any; text: string };

type Ctx = {
  token?: string;
  last?: ApiResult;
  addResults: ApiResult[];
  memberId?: number;
  otherMemberId?: number;
  addressId?: number;
  productId?: number;
  skuId: number;
  unitPrice: number;
  cartId?: number;
  orderId?: number;
  orderSn?: string;
  confirmPayAmount?: number;
  orderCountBefore?: number;
};

const ctx: Ctx = { addResults: [], skuId: DEFAULT_SKU, unitPrice: 100 };

function resetCtx() {
  for (const key of Object.keys(ctx) as (keyof Ctx)[]) {
    if (key === 'skuId') continue;
    if (key === 'unitPrice') continue;
    delete (ctx as any)[key];
  }
  ctx.addResults = [];
}

/* ------------------------------ 基础设施 ------------------------------ */

let pool: mysql.Pool | undefined;
function db(): mysql.Pool {
  pool ??= mysql.createPool({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? 'root',
    database: process.env.MYSQL_DATABASE ?? 'mall',
    connectionLimit: 4,
  });
  return pool;
}

async function rows<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [result] = await db().execute(sql, params);
  return result as T[];
}

async function one<T = any>(sql: string, params: any[] = []): Promise<T> {
  const list = await rows<T>(sql, params);
  return list[0];
}

async function exec(sql: string, params: any[] = []): Promise<void> {
  await db().execute(sql, params);
}

function toQuery(params?: Record<string, any>): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
    else sp.append(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** token 传 null 表示刻意不发 Authorization；不传则复用已登录 token */
async function call(
  request: any,
  method: 'GET' | 'POST',
  path: string,
  opt: { params?: Record<string, any>; data?: any; token?: string | null } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  const token = opt.token === undefined ? ctx.token : opt.token;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  else headers['Authorization'] = undefined as unknown as string;
  if (opt.data !== undefined) headers['Content-Type'] = 'application/json';

  const url = `${BASE}${path}${toQuery(opt.params)}`;
  const response = await request.fetch(url, {
    method,
    headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => typeof v === 'string')),
    data: opt.data,
    failOnStatusCode: false,
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null; // 非 JSON：Spring 默认错误体 / alipay 的 text/html
  }
  const result: ApiResult = { status: response.status(), body, text };
  ctx.last = result;
  return result;
}

async function login(request: any, username = MAIN_MEMBER.username, password = PASSWORD): Promise<string> {
  const res = await call(request, 'POST', '/sso/login', { params: { username, password }, token: null });
  expect(res.body?.code, `登录失败：${res.text}`).toBe(200);
  ctx.token = res.body.data.token;
  return ctx.token as string;
}

/** 通过 /sso/getAuthCode + /sso/register 保证会员存在（dev 环境验证码明文返回，可直接用于注册） */
async function ensureMember(request: any, member: { username: string; telephone: string }) {
  const codeRes = await call(request, 'GET', '/sso/getAuthCode', { params: { telephone: member.telephone }, token: null });
  const authCode = codeRes.body?.data;
  expect(authCode, `获取验证码失败：${codeRes.text}`).toBeTruthy();
  const regRes = await call(request, 'POST', '/sso/register', {
    params: { username: member.username, password: PASSWORD, telephone: member.telephone, authCode },
    token: null,
  });
  const message = String(regRes.body?.message ?? '');
  const ok = regRes.body?.code === 200 || /已经存在/.test(message);
  expect(ok, `注册/校验会员失败：${regRes.text}`).toBe(true);
}

async function ensureAddress(memberId: number): Promise<number> {
  const exist = await one<{ id: number }>(
    'SELECT id FROM ums_member_receive_address WHERE member_id = ? ORDER BY id LIMIT 1',
    [memberId],
  );
  if (exist?.id) return exist.id;
  await exec(
    `INSERT INTO ums_member_receive_address
       (member_id, name, phone_number, default_status, post_code, province, city, region, detail_address)
     VALUES (?, 'BDD收货人', '13800000001', 1, '200000', '上海市', '上海市', '浦东新区', 'BDD测试地址1号')`,
    [memberId],
  );
  const created = await one<{ id: number }>(
    'SELECT MAX(id) AS id FROM ums_member_receive_address WHERE member_id = ?',
    [memberId],
  );
  return created.id;
}

async function clearCart(request: any) {
  await call(request, 'POST', '/cart/clear');
}

async function addCart(request: any, skuId: number, quantity: number): Promise<ApiResult> {
  const res = await call(request, 'POST', '/cart/add', {
    data: {
      productId: ctx.productId,
      productSkuId: skuId,
      quantity,
      price: ctx.unitPrice,
      productName: 'BDD测试商品',
      productSubTitle: 'BDD 自动化专用',
      productSkuCode: `BDD-SKU-${skuId}`,
      productAttr: '[{"key":"颜色","value":"红色"}]',
    },
  });
  ctx.addResults.push(res);
  return res;
}

async function syncCartId(request: any, skuId: number) {
  const res = await call(request, 'GET', '/cart/list');
  expect(res.body?.code, `查询购物车失败：${res.text}`).toBe(200);
  const item = (res.body.data ?? []).find((it: any) => Number(it.productSkuId) === skuId);
  expect(item, `购物车中找不到 SKU ${skuId}`).toBeTruthy();
  ctx.cartId = item.id;
}

/** 造一张本人待付款订单（走真实下单接口），并把 orderId 放进上下文 */
async function createPendingOrder(request: any, skuId = ctx.skuId, quantity = 2) {
  if (!ctx.token) await login(request);
  await clearCart(request);
  await addCart(request, skuId, quantity);
  await syncCartId(request, skuId);
  const res = await call(request, 'POST', '/order/generateOrder', {
    data: {
      memberReceiveAddressId: ctx.addressId,
      useIntegration: 0,
      payType: 1,
      cartIds: [ctx.cartId],
    },
  });
  expect(res.body?.code, `造单失败：${res.text}`).toBe(200);
  ctx.orderId = res.body.data.order.id;
  ctx.orderSn = res.body.data.order.orderSn;
  ctx.last = res;
}

/* ------------------------------ 背景 / 前置条件 ------------------------------ */

Given(
  '重置测试数据：会员 {string} 存在、购物车为空、SKU {int} 单价 {float}、可用库存 {int}、锁定库存 {int}',
  async ({ request }, username: string, skuId: number, price: number, stock: number, lockStock: number) => {
    resetCtx();
    ctx.skuId = skuId;
    ctx.unitPrice = price;

    const sku = await one<{ id: number; product_id: number }>(
      'SELECT id, product_id FROM pms_sku_stock WHERE id = ?',
      [skuId],
    );
    expect(sku, `SKU ${skuId} 不存在，请先在测试库准备商品数据`).toBeTruthy();
    ctx.productId = sku.product_id;
    await exec('UPDATE pms_sku_stock SET price = ?, stock = ?, lock_stock = ? WHERE id = ?', [
      price,
      stock,
      lockStock,
      skuId,
    ]);

    await ensureMember(request, MAIN_MEMBER);
    const member = await one<{ id: number }>('SELECT id FROM ums_member WHERE username = ?', [MAIN_MEMBER.username]);
    ctx.memberId = member.id;
    await exec('UPDATE oms_cart_item SET delete_status = 1 WHERE member_id = ?', [member.id]);
    await exec('UPDATE ums_member SET integration = 0 WHERE id = ?', [member.id]);
    ctx.addressId = await ensureAddress(member.id);

    ctx.orderCountBefore = (
      await one<{ c: number }>('SELECT COUNT(*) AS c FROM oms_order WHERE member_id = ?', [member.id])
    ).c;
  },
);

Given('会员 {string} 已登录', async ({ request }, username: string) => {
  await login(request, username);
});

Given('会员已登录且购物车含 SKU {int} 数量 {int}', async ({ request }, skuId: number, quantity: number) => {
  if (!ctx.token) await login(request);
  await clearCart(request);
  const res = await addCart(request, skuId, quantity);
  expect(res.body?.code, `加购失败：${res.text}`).toBe(200);
  await syncCartId(request, skuId);
});

Given('存在本人待付款订单：SKU {int} 数量 {int}', async ({ request }, skuId: number, quantity: number) => {
  await createPendingOrder(request, skuId, quantity);
});

Given('本人订单状态为 {int}', async ({ request }, status: number) => {
  await createPendingOrder(request);
  if (status === 0) return;
  // status>=1 说明已支付：先走真实支付回调，保证 stock/lock_stock 与状态自洽
  const pay = await call(request, 'POST', '/order/paySuccess', { params: { orderId: ctx.orderId, payType: 1 } });
  expect(pay.body?.code, `支付回调失败：${pay.text}`).toBe(200);
  if (status !== 1) {
    // 已发货(2)等状态无前台接口可造，直接改库（仅改状态，不动库存，与真实发货后的账实一致）
    await exec('UPDATE oms_order SET status = ? WHERE id = ?', [status, ctx.orderId]);
  }
});

Given('存在另一个会员的待付款订单', async ({ request }) => {
  const mainToken = ctx.token ?? (await login(request));
  await ensureMember(request, OTHER_MEMBER);
  await login(request, OTHER_MEMBER.username);
  const other = await one<{ id: number }>('SELECT id FROM ums_member WHERE username = ?', [OTHER_MEMBER.username]);
  ctx.otherMemberId = other.id;
  const otherAddressId = await ensureAddress(other.id);
  await clearCart(request);
  const add = await addCart(request, ctx.skuId, 1);
  expect(add.body?.code, `他人加购失败：${add.text}`).toBe(200);
  await syncCartId(request, ctx.skuId);
  const order = await call(request, 'POST', '/order/generateOrder', {
    data: { memberReceiveAddressId: otherAddressId, useIntegration: 0, payType: 1, cartIds: [ctx.cartId] },
  });
  expect(order.body?.code, `他人下单失败：${order.text}`).toBe(200);
  // 恢复主会员身份，并把 orderId 指向他人订单，用于越权用例
  ctx.token = mainToken;
  ctx.orderId = order.body.data.order.id;
  ctx.last = order;
});

/* ------------------------------ 操作步骤 ------------------------------ */

When('会员以用户名 {string} 和密码 {string} 调用登录接口', async ({ request }, username: string, password: string) => {
  await call(request, 'POST', '/sso/login', { params: { username, password }, token: null });
});

When('会员以用户名 {string} 和错误密码 {string} 调用登录接口', async ({ request }, username: string, password: string) => {
  await call(request, 'POST', '/sso/login', { params: { username, password }, token: null });
});

When('不携带 Authorization 头调用购物车列表接口', async ({ request }) => {
  await call(request, 'GET', '/cart/list', { token: null });
});

When('以数量 {int} 将 SKU {int} 加入购物车', async ({ request }, quantity: number, skuId: number) => {
  ctx.addResults = [];
  await addCart(request, skuId, quantity);
});

When('再次以数量 {int} 将 SKU {int} 加入购物车', async ({ request }, quantity: number, skuId: number) => {
  await addCart(request, skuId, quantity);
});

When('以该购物车项 id 数组作为请求体调用生成确认单接口', async ({ request }) => {
  const res = await call(request, 'POST', '/order/generateConfirmOrder', { data: [ctx.cartId] });
  ctx.confirmPayAmount = Number(res.body?.data?.calcAmount?.payAmount);
});

When('以 [] 作为请求体调用生成确认单接口', async ({ request }) => {
  await call(request, 'POST', '/order/generateConfirmOrder', { data: [] });
});

When('携带 memberReceiveAddressId 与 cartIds 调用生成订单接口', async ({ request }) => {
  const res = await call(request, 'POST', '/order/generateOrder', {
    data: { memberReceiveAddressId: ctx.addressId, useIntegration: 0, payType: 1, cartIds: [ctx.cartId] },
  });
  ctx.orderId = res.body?.data?.order?.id;
  ctx.orderSn = res.body?.data?.order?.orderSn;
});

When('携带空 memberReceiveAddressId 与 cartIds 调用生成订单接口', async ({ request }) => {
  await call(request, 'POST', '/order/generateOrder', {
    data: { useIntegration: 0, payType: 1, cartIds: [ctx.cartId] },
  });
});

When(
  '携带 memberReceiveAddressId、cartIds 与不存在的 couponId {int} 调用生成订单接口',
  async ({ request }, couponId: number) => {
    await call(request, 'POST', '/order/generateOrder', {
      data: { memberReceiveAddressId: ctx.addressId, couponId, useIntegration: 0, payType: 1, cartIds: [ctx.cartId] },
    });
  },
);

When('通过购物车修改数量接口将数量改为 {int}', async ({ request }, quantity: number) => {
  const res = await call(request, 'GET', '/cart/update/quantity', { params: { id: ctx.cartId, quantity } });
  expect(res.body?.code, `修改数量失败：${res.text}`).toBe(200);
});

When('调用用户取消订单接口', async ({ request }) => {
  await call(request, 'POST', '/order/cancelUserOrder', { params: { orderId: ctx.orderId } });
});

When('调用支付成功回调接口，orderId 取当前订单，payType 为 {int}', async ({ request }, payType: number) => {
  await call(request, 'POST', '/order/paySuccess', { params: { orderId: ctx.orderId, payType } });
});

When('调用用户确认收货接口', async ({ request }) => {
  await call(request, 'POST', '/order/confirmReceiveOrder', { params: { orderId: ctx.orderId } });
});

When('调用用户删除订单接口', async ({ request }) => {
  await call(request, 'POST', '/order/deleteOrder', { params: { orderId: ctx.orderId } });
});

When('以手机号 {string} 调用获取验证码接口', async ({ request }, telephone: string) => {
  await call(request, 'GET', '/sso/getAuthCode', { params: { telephone }, token: null });
});

/* ------------------------------ 预期结果 ------------------------------ */

Then('HTTP 状态为 {int}', async ({}, expected: number) => {
  expect(ctx.last?.status).toBe(expected);
});

Then('接口返回业务码 {int}', async ({}, expected: number) => {
  expect(ctx.last?.body?.code, `实际响应：${ctx.last?.text}`).toBe(expected);
});

Then('响应体业务码为 {int}', async ({}, expected: number) => {
  expect(ctx.last?.body?.code, `实际响应：${ctx.last?.text}`).toBe(expected);
});

Then('响应 message 为 {string}', async ({}, expected: string) => {
  expect(ctx.last?.body?.message).toBe(expected);
});

Then('响应 message 包含 {string}', async ({}, expected: string) => {
  expect(String(ctx.last?.body?.message ?? '')).toContain(expected);
});

Then('响应体包含非空的 token', async () => {
  expect(ctx.last?.body?.data?.token).toBeTruthy();
});

Then('响应中不包含 token', async () => {
  expect(ctx.last?.body?.data?.token ?? null).toBeNull();
});

Then('tokenHead 为 {string}', async ({}, expected: string) => {
  expect(ctx.last?.body?.data?.tokenHead).toBe(expected);
});

Then('响应 data 为 {int} 位数字', async ({}, length: number) => {
  const data = String(ctx.last?.body?.data ?? '');
  expect(data).toMatch(new RegExp(`^\\d{${length}}$`));
});

Then('两次加购均返回业务码 {int}', async ({}, expected: number) => {
  expect(ctx.addResults.length).toBe(2);
  for (const res of ctx.addResults) {
    expect(res.body?.code, `加购响应：${res.text}`).toBe(expected);
  }
});

Then('购物车中该 SKU 只有 1 条记录且数量为 {int}', async ({ request }, quantity: number) => {
  const res = await call(request, 'GET', '/cart/list');
  const items = (res.body?.data ?? []).filter((it: any) => Number(it.productSkuId) === ctx.skuId);
  expect(items.length).toBe(1);
  expect(items[0].quantity).toBe(quantity);
});

Then('购物车中该 SKU 数量为 {int}', async ({ request }, quantity: number) => {
  const res = await call(request, 'GET', '/cart/list');
  const items = (res.body?.data ?? []).filter((it: any) => Number(it.productSkuId) === ctx.skuId);
  expect(items.length, 'expected cart item to exist').toBeGreaterThan(0);
  expect(items[0].quantity).toBe(quantity);
});

Then('购物车列表已不含 SKU {int}', async ({ request }, skuId: number) => {
  const res = await call(request, 'GET', '/cart/list');
  const items = (res.body?.data ?? []).filter((it: any) => Number(it.productSkuId) === skuId);
  expect(items.length).toBe(0);
});

Then('购物车列表已含 SKU {int}', async ({ request }, skuId: number) => {
  const res = await call(request, 'GET', '/cart/list');
  const items = (res.body?.data ?? []).filter((it: any) => Number(it.productSkuId) === skuId);
  expect(items.length).toBeGreaterThan(0);
});

Then('data.calcAmount.totalAmount 为 {float}', async ({}, expected: number) => {
  expect(Number(ctx.last?.body?.data?.calcAmount?.totalAmount)).toBeCloseTo(expected, 2);
});

Then('data.calcAmount.freightAmount 为 {float}', async ({}, expected: number) => {
  expect(Number(ctx.last?.body?.data?.calcAmount?.freightAmount)).toBeCloseTo(expected, 2);
});

Then('data.calcAmount.payAmount 等于 totalAmount 减 promotionAmount', async () => {
  const calc = ctx.last?.body?.data?.calcAmount ?? {};
  const total = Number(calc.totalAmount);
  const promotion = Number(calc.promotionAmount);
  expect(Number(calc.payAmount)).toBeCloseTo(total - promotion, 2);
});

Then('data.memberReceiveAddressList 非空', async () => {
  expect((ctx.last?.body?.data?.memberReceiveAddressList ?? []).length).toBeGreaterThan(0);
});

Then('data.integrationConsumeSetting 非空', async () => {
  expect(ctx.last?.body?.data?.integrationConsumeSetting ?? null).not.toBeNull();
});

Then('data.cartPromotionItemList 有 {int} 条', async ({}, expected: number) => {
  expect((ctx.last?.body?.data?.cartPromotionItemList ?? []).length).toBe(expected);
});

Then('data.order.status 为 {int}', async ({}, expected: number) => {
  expect(ctx.last?.body?.data?.order?.status).toBe(expected);
});

Then('data.order.orderSn 为 {int} 位数字', async ({}, length: number) => {
  const orderSn = String(ctx.last?.body?.data?.order?.orderSn ?? '');
  expect(orderSn).toMatch(new RegExp(`^\\d{${length}}$`));
});

Then('data.order.payAmount 与确认单应付金额一致', async () => {
  expect(ctx.confirmPayAmount, '需先执行生成确认单步骤').not.toBeUndefined();
  expect(Number(ctx.last?.body?.data?.order?.payAmount)).toBeCloseTo(Number(ctx.confirmPayAmount), 2);
});

Then('按 status {int} 查询订单列表包含当前订单', async ({ request }, status: number) => {
  const res = await call(request, 'GET', '/order/list', { params: { status, pageNum: 1, pageSize: 50 } });
  expect(res.body?.code, `查询订单列表失败：${res.text}`).toBe(200);
  const list = res.body?.data?.list ?? [];
  expect(list.some((order: any) => order.id === ctx.orderId)).toBe(true);
});

Then('订单表无当前会员新增订单', async () => {
  const current = (
    await one<{ c: number }>('SELECT COUNT(*) AS c FROM oms_order WHERE member_id = ?', [ctx.memberId])
  ).c;
  expect(current).toBe(ctx.orderCountBefore);
});

Then('SKU {int} 的可用库存为 {int}', async ({}, skuId: number, expected: number) => {
  const sku = await one<{ stock: number }>('SELECT stock FROM pms_sku_stock WHERE id = ?', [skuId]);
  expect(sku.stock).toBe(expected);
});

Then('SKU {int} 的锁定库存为 {int}', async ({}, skuId: number, expected: number) => {
  const sku = await one<{ lock_stock: number }>('SELECT lock_stock FROM pms_sku_stock WHERE id = ?', [skuId]);
  expect(sku.lock_stock).toBe(expected);
});

Then('订单状态为 {int}', async ({}, expected: number) => {
  const order = await one<{ status: number }>('SELECT status FROM oms_order WHERE id = ?', [ctx.orderId]);
  expect(order.status).toBe(expected);
});

Then('订单支付时间非空', async () => {
  const order = await one<{ payment_time: Date | null }>('SELECT payment_time FROM oms_order WHERE id = ?', [ctx.orderId]);
  expect(order.payment_time).not.toBeNull();
});

Then('订单 payType 为 {int}', async ({}, expected: number) => {
  const order = await one<{ pay_type: number }>('SELECT pay_type FROM oms_order WHERE id = ?', [ctx.orderId]);
  expect(order.pay_type).toBe(expected);
});

Then('订单 confirm_status 为 {int} 且 receive_time 非空', async ({}, expected: number) => {
  const order = await one<{ confirm_status: number; receive_time: Date | null }>(
    'SELECT confirm_status, receive_time FROM oms_order WHERE id = ?',
    [ctx.orderId],
  );
  expect(order.confirm_status).toBe(expected);
  expect(order.receive_time).not.toBeNull();
});

Then('订单 delete_status 为 {int}', async ({}, expected: number) => {
  const order = await one<{ delete_status: number }>('SELECT delete_status FROM oms_order WHERE id = ?', [
    ctx.orderId,
  ]);
  expect(order.delete_status).toBe(expected);
});
