// server.ts
// 雅宝教育工作室 V4版本 - Deno Deploy (前后端分离)

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const MOBILE_PHONE_REGEX = /^1\d{10}$/;
const LANDLINE_PHONE_REGEX = /^0\d{2,3}-?\d{7,8}$/;
const textEncoder = new TextEncoder();
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_PREFIX = "pbkdf2_sha256";
const PASSWORD_HASH_ITERATIONS = 210000;
const AUTH_CODE_SKIP_VERIFICATION = Deno.env.get("TUTOR_AUTH_SKIP_CODE") === "true";

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function normalizePhone(value: unknown) {
  return normalizeText(value).replace(/\s+/g, "");
}

function isValidPhone(phone: string) {
  return MOBILE_PHONE_REGEX.test(phone) || LANDLINE_PHONE_REGEX.test(phone);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const normalized = normalizeText(hex);
  if (!normalized || normalized.length % 2 !== 0) {
    throw new Error("无效的十六进制字符串");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function derivePasswordBits(password: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(derivedBits);
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePasswordBits(password, salt, PASSWORD_HASH_ITERATIONS);
  return `${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(derived)}`;
}

async function verifyPassword(password: string, storedValue: unknown) {
  if (typeof storedValue !== "string" || !storedValue) return false;

  if (!storedValue.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
    return storedValue === password;
  }

  const [, iterationsText, saltHex, digestHex] = storedValue.split("$");
  const iterations = Number.parseInt(iterationsText, 10);
  if (!iterations || !saltHex || !digestHex) return false;

  const expectedDigest = hexToBytes(digestHex);
  const actualDigest = await derivePasswordBits(password, hexToBytes(saltHex), iterations);
  return timingSafeEqual(actualDigest, expectedDigest);
}

// 格式化为北京时间 (UTC+8)
function formatToBeijingTime(dateStr: string | Date = new Date()) {
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

// 重写 console 方法，为所有日志加上北京时间前缀
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function (...args) {
  originalConsoleLog(`[${formatToBeijingTime()}]`, ...args);
};
console.warn = function (...args) {
  originalConsoleWarn(`[${formatToBeijingTime()}]`, ...args);
};
console.error = function (...args) {
  originalConsoleError(`[${formatToBeijingTime()}]`, ...args);
};

// === 企业微信群机器人通知 ===
async function sendWeWorkNotification(appointment: {
  id: string;
  name: string;
  phone: string;
  course: string;
  createdAt: string;
}) {
  const weworkWebhookUrl = Deno.env.get("WEWORK_WEBHOOK_URL");
  if (!weworkWebhookUrl) {
    console.warn("企业微信群通知已跳过：未配置 WEWORK_WEBHOOK_URL 环境变量。");
    return { sent: false, skipped: true, reason: "未配置 WEWORK_WEBHOOK_URL 环境变量" };
  }

  const payload = {
    msgtype: "markdown",
    markdown: {
      content: `📢 **新家长预约提醒**\n> 👤 姓名：<font color="info">${appointment.name}</font>\n> 📞 电话：<font color="info">${appointment.phone}</font>\n> 📚 课程：${appointment.course}\n> 🕒 时间：${formatToBeijingTime(appointment.createdAt)}`
    }
  };

  const response = await fetch(weworkWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`企业微信群通知发送失败: HTTP ${response.status} ${errorText}`);
  }

  const responseText = await response.text();
  let responseData: Record<string, unknown> | null = null;

  try {
    responseData = responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(`企业微信群通知返回了非 JSON 响应: ${responseText}`);
  }

  if (responseData && responseData.errcode !== 0) {
    throw new Error(
      `企业微信群通知发送失败: errcode=${String(responseData.errcode)}, errmsg=${String(responseData.errmsg ?? "")}`
    );
  }

  return { sent: true, skipped: false, responseData, reason: "" };
}

// === 家教兼职专属企业微信机器人通知 ===
async function sendTutorWeWorkNotification(type: 'post' | 'apply' | 'delete' | 'cancel_apply', data: any) {
  // 使用你新提供的兼职专属 webhook
  const tutorWebhookUrl = Deno.env.get("TUTOR_WEWORK_WEBHOOK_URL");
  if (!tutorWebhookUrl) {
    console.warn("家教通知已跳过：未配置 TUTOR_WEWORK_WEBHOOK_URL 环境变量。");
    return;
  }
  
  let content = "";
  if (type === 'post') {
    content = `📢 **新家教需求发布**\n> 📍 地址：<font color="info">${data.address}</font>\n> 🎓 年级：<font color="info">${data.grade}</font>\n> 📚 科目：<font color="info">${data.subject}</font>\n> 💰 费用：<font color="warning">${data.fee}</font>\n> 🕒 时间：${data.time}\n> 👨‍🎓 学生情况：${data.studentInfo}\n> 👩‍🏫 老师要求：${data.requirement}\n> 📝 备注：${data.remark}\n> ⏰ 提交时间：${formatToBeijingTime()}`;
  } else if (type === 'apply') {
    content = `🎯 **新老师接单申请**\n> 🏷️ 申请岗位：<font color="info">${data.jobTitle}</font>\n> 👤 老师姓名：<font color="info">${data.name}</font>\n> 📞 联系电话：<font color="warning">${data.phone}</font>\n> ⏰ 申请时间：${formatToBeijingTime()}`;
  } else if (type === 'delete') {
    content = `🗑️ **家教需求已取消/删除**\n> 📍 地址：<font color="comment">${data.address}</font>\n> 🎓 年级：<font color="comment">${data.grade}</font>\n> 📚 科目：<font color="comment">${data.subject}</font>\n> ⏰ 取消时间：${formatToBeijingTime()}`;
  } else if (type === 'cancel_apply') {
    content = `🔙 **老师已取消接单**\n> 🏷️ 释放岗位：<font color="info">${data.jobTitle}</font>\n> 👤 老师姓名：<font color="comment">${data.name}</font>\n> 📞 联系电话：<font color="comment">${data.phone}</font>\n> ⏰ 取消时间：${formatToBeijingTime()}\n> ℹ️ *该岗位已重新退回大厅*`;
  }

  const payload = {
    msgtype: "markdown",
    markdown: { content }
  };

  try {
    const response = await fetch(tutorWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      console.error(`[家教通知异常] HTTP ${response.status} ${await response.text()}`);
    } else {
      const typeStr = { post: '发布需求', apply: '接单申请', delete: '删除需求', cancel_apply: '取消接单' }[type];
      console.log(`[家教通知成功] ${typeStr} 已推送到兼职专属企微群`);
    }
  } catch (error) {
    console.error("[家教通知异常] 发生错误:", error);
  }
}

async function sendStudyRoomWeWorkNotification(type: "reserve" | "cancel", data: any) {
  const studyRoomWebhookUrl = Deno.env.get("STUDY_ROOM_WEWORK_WEBHOOK_URL");
  if (!studyRoomWebhookUrl) {
    console.warn("自习室通知已跳过：未配置 STUDY_ROOM_WEWORK_WEBHOOK_URL 环境变量。");
    return;
  }

  const title = type === "reserve" ? "自习室新预约" : "自习室预约取消";
  const icon = type === "reserve" ? "📚" : "🗑️";
  const content = `${icon} **${title}**\n> 👤 姓名：<font color="info">${data.name}</font>\n> 📞 电话：<font color="info">${data.phone}</font>\n${data.timeSlotsStr}> ⏰ 操作时间：${formatToBeijingTime()}`;

  const response = await fetch(studyRoomWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    }),
  });

  if (!response.ok) {
    throw new Error(`自习室企业微信通知发送失败: HTTP ${response.status} ${await response.text()}`);
  }
}

let kv: Deno.Kv | null = null;
try {
  // 检查当前环境是否支持 Deno.openKv
  if (typeof Deno.openKv === "function") {
    kv = await Deno.openKv();
    console.log("Deno KV 数据库连接成功！");
  } else {
    console.warn("当前 Deno Deploy 环境未开启 KV 支持 (Deno.openKv is not a function)。将使用模拟存储。");
  }
} catch (e) {
  console.error("连接 Deno KV 失败:", e);
}

const TUTOR_ADMIN_EMAIL = normalizeEmail(Deno.env.get("TUTOR_ADMIN_EMAIL"));
const TUTOR_ADMIN_PASSWORD_HASH = normalizeText(Deno.env.get("TUTOR_ADMIN_PASSWORD_HASH"));
const TUTOR_ADMIN_PASSWORD = normalizeText(Deno.env.get("TUTOR_ADMIN_PASSWORD"));

function isTutorAdminEmail(email: string | null) {
  return Boolean(email && TUTOR_ADMIN_EMAIL && email === TUTOR_ADMIN_EMAIL);
}

async function verifyTutorAuthCode(email: string, code: string) {
  if (AUTH_CODE_SKIP_VERIFICATION) {
    return true;
  }

  if (!kv) return false;
  const savedCodeRes = await kv.get(["tutor_auth_codes", email]);
  const savedCode = savedCodeRes.value as { code?: string; expiresAt?: number } | null;
  return Boolean(savedCode && savedCode.code === code && typeof savedCode.expiresAt === "number" && savedCode.expiresAt >= Date.now());
}

async function verifyAdminCredentials(email: string, password: string) {
  if (!TUTOR_ADMIN_EMAIL || email !== TUTOR_ADMIN_EMAIL) return false;
  if (TUTOR_ADMIN_PASSWORD_HASH) {
    return await verifyPassword(password, TUTOR_ADMIN_PASSWORD_HASH);
  }
  return Boolean(TUTOR_ADMIN_PASSWORD) && password === TUTOR_ADMIN_PASSWORD;
}

async function createTutorToken(email: string) {
  const token = crypto.randomUUID();
  if (kv) {
    await kv.set(
      ["tutor_tokens", token],
      { email, expiresAt: Date.now() + TOKEN_TTL_MS },
      { expireIn: TOKEN_TTL_MS },
    );
  }
  return token;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1. 处理页面访问请求：读取并返回 index.html
  if (req.method === "GET" && url.pathname === "/") {
    try {
      // 动态读取独立的 index.html 文件
      const htmlContent = await Deno.readTextFile("./index.html");
      return new Response(htmlContent, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    } catch (error) {
      console.error("无法读取 index.html:", error);
      return new Response("Error: index.html not found.", { status: 500 });
    }
  }

  // 2. 预留 POST 接口：处理家长的预约信息，并存入 Deno.Kv
  if (req.method === "POST" && url.pathname === "/api/appointment") {
    try {
      let data;
      try {
        data = await req.json();
      } catch (error) {
        console.error("解析请求JSON失败:", error);
        return new Response(
          JSON.stringify({ success: false, error: "无效的请求数据格式" }),
          { status: 400, headers: JSON_HEADERS }
        );
      }

      const name = normalizeText(data.name);
      const phone = normalizePhone(data.phone);
      const course = normalizeText(data.course) || "未指定";

      // 简单的数据校验
      if (!name || !phone) {
        return new Response(
          JSON.stringify({ success: false, error: "姓名和电话为必填项" }),
          { status: 400, headers: JSON_HEADERS }
        );
      }

      if (phone.length < 10 || phone.length > 12) {
        return new Response(
          JSON.stringify({ success: false, error: "电话长度不正确，请输入有效的手机号或座机号" }),
          { status: 400, headers: JSON_HEADERS }
        );
      }

      if (!isValidPhone(phone)) {
        return new Response(
          JSON.stringify({ success: false, error: "电话格式不正确，请重新输入" }),
          { status: 400, headers: JSON_HEADERS }
        );
      }

      // 生成唯一预约 ID
      const appointmentId = crypto.randomUUID();

      // 构造要存储的数据结构
      const appointmentRecord = {
        id: appointmentId,
        name,
        phone,
        course,
        createdAt: new Date().toISOString(),
        status: "pending" // 初始状态为待处理
      };

      // 存入 Deno KV (如果可用)，否则记录到日志中
      if (kv) {
        try {
          await kv.set(["appointments", appointmentId], appointmentRecord);
          console.log(`[KV存储成功] 新预约信息: ${name} (${phone}) - ${course}`);
        } catch (kvError) {
          console.error(`[KV存储失败] 无法写入数据:`, kvError);
          console.log(`[降级记录] 新预约信息: ${name} (${phone}) - ${course}`);
        }
      } else {
        console.log(`[模拟存储] 新预约信息: ${name} (${phone}) - ${course} (提示：当前环境未连接真实 KV 数据库)`);
      }

      let weworkSent = false;
      let weworkReason = "";

      // 尝试发送企业微信群通知
      try {
        console.log("[通知开始] 准备发送企业微信群消息");
        const weworkResult = await sendWeWorkNotification(appointmentRecord);
        weworkSent = weworkResult.sent;
        weworkReason = typeof weworkResult.reason === "string" ? weworkResult.reason : "";

        if (weworkSent) {
          console.log("[通知成功] 企业微信群消息已推送", weworkResult.responseData ?? "");
        } else {
          console.warn(`[通知跳过] 企业微信群消息未发送: ${weworkReason}`);
        }
      } catch (notifyError) {
        weworkReason = notifyError instanceof Error ? notifyError.message : String(notifyError);
        console.error("[通知异常] 发生未捕获的通知错误:", notifyError);
      }

      // 返回成功响应
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "预约信息已成功提交！",
          id: appointmentId,
          notifications: { weworkSent, weworkReason }
        }),
        { 
          status: 201, 
          headers: JSON_HEADERS 
        }
      );
    } catch (globalError) {
      console.error("POST /api/appointment 发生未捕获的异常:", globalError);
      return new Response(
        JSON.stringify({ success: false, error: "服务器内部错误", details: String(globalError) }),
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 3. 新增 GET 接口：用于查看已提交的预约列表 (简单管理员接口)
  if (req.method === "GET" && url.pathname === "/api/appointments") {
    if (!kv) {
      return new Response(
        JSON.stringify({ success: false, error: "未连接 Deno KV 数据库" }),
        { status: 500, headers: JSON_HEADERS }
      );
    }

    try {
      const appointments = [];
      const entries = kv.list({ prefix: ["appointments"] });
      for await (const entry of entries) {
        appointments.push(entry.value);
      }
      
      // 按时间倒序排序 (最新的在前面)
      appointments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return new Response(
        JSON.stringify({ success: true, data: appointments }),
        { status: 200, headers: JSON_HEADERS }
      );
    } catch (error) {
      console.error("获取预约列表失败:", error);
      return new Response(
        JSON.stringify({ success: false, error: "获取数据失败" }),
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // === 兼职平台 Auth 辅助函数 ===
  async function getUserEmail(req: Request) {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token || !kv) return null;
    const res = await kv.get(["tutor_tokens", token]);
    const tokenRecord = res.value;
    if (!tokenRecord) return null;

    if (typeof tokenRecord === "string") {
      return tokenRecord;
    }

    if (typeof tokenRecord === "object" && tokenRecord !== null && "email" in tokenRecord) {
      const expiresAt = typeof tokenRecord.expiresAt === "number" ? tokenRecord.expiresAt : 0;
      if (expiresAt && expiresAt < Date.now()) {
        await kv.delete(["tutor_tokens", token]);
        return null;
      }
      return typeof tokenRecord.email === "string" ? tokenRecord.email : null;
    }

    return null;
  }

  // 4. 返回独立的家教兼职平台页面
  if (req.method === "GET" && url.pathname === "/tutor") {
    try {
      const htmlContent = await Deno.readTextFile("./tutor.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: tutor.html not found.", { status: 500 });
    }
  }

  // 4.1 返回独立的自习室预定页面
  if (req.method === "GET" && url.pathname === "/study-room.html") {
    try {
      const htmlContent = await Deno.readTextFile("./study-room.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: study-room.html not found.", { status: 500 });
    }
  }

  // 4.2 返回独立的智能评估页面
  if (req.method === "GET" && url.pathname === "/student-eval.html") {
    try {
      const htmlContent = await Deno.readTextFile("./student-eval.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: student-eval.html not found.", { status: 500 });
    }
  }

  // 4.3 返回智能评估绑定页面
  if (req.method === "GET" && url.pathname === "/student-bind.html") {
    try {
      const htmlContent = await Deno.readTextFile("./student-bind.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: student-bind.html not found.", { status: 500 });
    }
  }

  // 4.4 返回教务后台演示页面
  if (req.method === "GET" && url.pathname === "/teacher-dashboard.html") {
    try {
      const htmlContent = await Deno.readTextFile("./teacher-dashboard.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: teacher-dashboard.html not found.", { status: 500 });
    }
  }

  // 4.5 返回 K12 独立页面
  if (req.method === "GET" && url.pathname === "/k12.html") {
    try {
      const htmlContent = await Deno.readTextFile("./k12.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: k12.html not found.", { status: 500 });
    }
  }

  // 4.6 返回成人教育独立页面
  if (req.method === "GET" && url.pathname === "/adult-education.html") {
    try {
      const htmlContent = await Deno.readTextFile("./adult-education.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: adult-education.html not found.", { status: 500 });
    }
  }

  // 4.7 返回 AI 评估独立页面
  if (req.method === "GET" && url.pathname === "/ai-eval.html") {
    try {
      const htmlContent = await Deno.readTextFile("./ai-eval.html");
      return new Response(htmlContent, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response("Error: ai-eval.html not found.", { status: 500 });
    }
  }

  // 5. 兼职平台核心 API
  if (url.pathname.startsWith("/api/tutor/")) {
    
    // 发送验证码
    if (req.method === "POST" && url.pathname === "/api/tutor/send-code") {
      try {
        const body = await req.json();
        const email = normalizeEmail(body.email);
        if (!email || !email.includes('@')) return new Response(JSON.stringify({ success: false, error: "邮箱格式不正确" }), { status: 400, headers: JSON_HEADERS });
        
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        if (kv) {
          await kv.set(["tutor_auth_codes", email], { code, expiresAt: Date.now() + 5 * 60 * 1000 });
        }
        
        console.log(`\n========================================`);
        console.log(`[验证码] 发送给 ${email} 的验证码是: ${code}`);
        console.log(`========================================\n`);

        const resendApiKey = Deno.env.get("RESEND_API_KEY");
        const notifyFrom = Deno.env.get("NOTIFY_EMAIL_FROM");
        
        if (resendApiKey && notifyFrom) {
           fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: notifyFrom,
              to: [email],
              subject: "雅宝家教兼职平台 - 登录验证码",
              html: `<p>您的登录验证码是：<strong>${code}</strong>，5分钟内有效。</p>`
            })
          }).catch(e => console.error("发送邮件失败", e));
        } else {
          console.warn("[警告] 未配置邮件环境变量，无法发送邮件。");
        }

        // 返回包含 code 的响应（仅用于测试环境或未配置邮件时方便直接看弹窗）
        return new Response(JSON.stringify({ success: true, debugCode: (!resendApiKey ? code : undefined) }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "请求失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 注册账号
    if (req.method === "POST" && url.pathname === "/api/tutor/register") {
      try {
        const body = await req.json();
        const email = normalizeEmail(body.email);
        const code = normalizeText(body.code);
        const password = normalizeText(body.password);
        
        if (!email || !email.includes('@')) return new Response(JSON.stringify({ success: false, error: "邮箱格式不正确" }), { status: 400, headers: JSON_HEADERS });
        if (!code || code.length !== 6) return new Response(JSON.stringify({ success: false, error: "请输入6位验证码" }), { status: 400, headers: JSON_HEADERS });
        if (!password || password.length < 6) return new Response(JSON.stringify({ success: false, error: "密码长度不能少于6位" }), { status: 400, headers: JSON_HEADERS });

        if (kv) {
          if (!(await verifyTutorAuthCode(email, code))) {
             return new Response(JSON.stringify({ success: false, error: "验证码无效或已过期" }), { status: 400, headers: JSON_HEADERS });
          }

          // 检查是否已注册
          const existingUser = await kv.get(["tutor_users", email]);
          if (existingUser.value) {
             return new Response(JSON.stringify({ success: false, error: "该邮箱已注册，请直接登录" }), { status: 400, headers: JSON_HEADERS });
          }

          const passwordHash = await hashPassword(password);
          await kv.set(["tutor_users", email], { passwordHash, createdAt: Date.now(), updatedAt: Date.now() });
          
          // 清理验证码记录
          await kv.delete(["tutor_auth_codes", email]);
          
          // 自动登录
          const token = await createTutorToken(email);
          return new Response(JSON.stringify({ success: true, token, email }), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify({ success: false, error: "KV 数据库不可用" }), { status: 500, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "注册失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 重置密码
    if (req.method === "POST" && url.pathname === "/api/tutor/reset-password") {
      try {
        const body = await req.json();
        const email = normalizeEmail(body.email);
        const code = normalizeText(body.code);
        const password = normalizeText(body.password);
        
        if (!email || !email.includes('@')) return new Response(JSON.stringify({ success: false, error: "邮箱格式不正确" }), { status: 400, headers: JSON_HEADERS });
        if (!code || code.length !== 6) return new Response(JSON.stringify({ success: false, error: "请输入6位验证码" }), { status: 400, headers: JSON_HEADERS });
        if (!password || password.length < 6) return new Response(JSON.stringify({ success: false, error: "密码长度不能少于6位" }), { status: 400, headers: JSON_HEADERS });

        if (kv) {
          if (!(await verifyTutorAuthCode(email, code))) {
             return new Response(JSON.stringify({ success: false, error: "验证码无效或已过期" }), { status: 400, headers: JSON_HEADERS });
          }

          const existingUser = await kv.get(["tutor_users", email]);
          if (!existingUser.value) {
             return new Response(JSON.stringify({ success: false, error: "该邮箱尚未注册" }), { status: 400, headers: JSON_HEADERS });
          }

          // 更新密码
          const passwordHash = await hashPassword(password);
          await kv.set(["tutor_users", email], { ...existingUser.value, passwordHash, updatedAt: Date.now() });
          await kv.delete(["tutor_auth_codes", email]);
          
          return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify({ success: false, error: "KV 数据库不可用" }), { status: 500, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "重置失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 账号密码登录
    if (req.method === "POST" && url.pathname === "/api/tutor/login") {
      try {
        const body = await req.json();
        const email = normalizeEmail(body.email);
        const password = normalizeText(body.password);
        
        if (!email || !email.includes('@')) {
          return new Response(JSON.stringify({ success: false, error: "邮箱格式不正确" }), { status: 400, headers: JSON_HEADERS });
        }
        
        if (!password) {
          return new Response(JSON.stringify({ success: false, error: "请输入密码" }), { status: 400, headers: JSON_HEADERS });
        }

        if (await verifyAdminCredentials(email, password)) {
          console.log(`[管理员登录成功] ${email}`);
          const token = await createTutorToken(email);
          return new Response(JSON.stringify({ success: true, token, email }), { headers: JSON_HEADERS });
        }

        // 验证密码
        if (kv) {
          const userRes = await kv.get(["tutor_users", email]);
          const user = userRes.value as Record<string, unknown> | null;
          
          if (!user) {
              return new Response(JSON.stringify({ success: false, error: "账号不存在，请先注册" }), { status: 400, headers: JSON_HEADERS });
          }
          
          const storedPassword = user.passwordHash ?? user.password;
          const passwordMatched = await verifyPassword(password, storedPassword);
          if (!passwordMatched) {
              return new Response(JSON.stringify({ success: false, error: "密码错误" }), { status: 400, headers: JSON_HEADERS });
          }

          if (typeof user.password === "string" && typeof user.passwordHash !== "string") {
            await kv.set(["tutor_users", email], {
              ...user,
              passwordHash: await hashPassword(password),
              password: undefined,
              updatedAt: Date.now(),
            });
          }

          const token = await createTutorToken(email);
          return new Response(JSON.stringify({ success: true, token, email }), { headers: JSON_HEADERS });
        }
        
        return new Response(JSON.stringify({ success: false, error: "KV 数据库不可用" }), { status: 500, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "登录失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 获取工作列表 (大厅 open / 我发布的 published / 我接单的 accepted)
    if (req.method === "GET" && url.pathname === "/api/tutor/jobs") {
      const type = url.searchParams.get("type") || "open"; 
      const userEmail = await getUserEmail(req);
      const isAdmin = isTutorAdminEmail(userEmail);
      
      if ((type === "published" || type === "accepted") && !userEmail) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), { status: 401, headers: JSON_HEADERS });
      }
      if (!kv) return new Response(JSON.stringify({ success: false, error: "KV不可用" }), { status: 500, headers: JSON_HEADERS });

      const jobs = [];
      for await (const entry of kv.list({ prefix: ["tutor_jobs"] })) {
        const job = entry.value as any;
        
        // 附加一个标识，告诉前端当前用户是否有权限编辑该岗位
        const canEdit = isAdmin || job.publisherEmail === userEmail;
        job.canEdit = canEdit;

        if (type === "open" && job.status === "open") jobs.push(job);
        if (type === "published" && job.publisherEmail === userEmail) jobs.push(job);
        if (type === "accepted" && job.status === "accepted" && job.acceptedByEmail === userEmail) jobs.push(job);
        
        // 管理员在“我发布的”可以看所有发布的帖子（可选，看需求，这里先保持原来逻辑，但允许编辑所有）
      }
      jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return new Response(JSON.stringify({ success: true, data: jobs, isAdmin }), { headers: JSON_HEADERS });
    }

    // ------------------------------------------
    // 以下接口必须鉴权
    // ------------------------------------------
    const userEmail = await getUserEmail(req);
    const isAdmin = isTutorAdminEmail(userEmail);

    if (!userEmail) {
      return new Response(JSON.stringify({ success: false, error: "未登录或登录已过期" }), { status: 401, headers: JSON_HEADERS });
    }

    // 发布岗位
    if (req.method === "POST" && url.pathname === "/api/tutor/job/post") {
      try {
        const data = await req.json();
        const id = crypto.randomUUID();
        const job = { id, publisherEmail: userEmail, ...data, status: "open", acceptedByEmail: null, createdAt: new Date().toISOString() };
        if (kv) await kv.set(["tutor_jobs", id], job);
        sendTutorWeWorkNotification("post", job);
        return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "发布失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 编辑岗位
    if (req.method === "POST" && url.pathname === "/api/tutor/job/edit") {
      try {
        const data = await req.json();
        if (kv) {
          const jobRes = await kv.get(["tutor_jobs", data.id]);
          const existingJob = jobRes.value as any;
          if (existingJob && (existingJob.publisherEmail === userEmail || isAdmin)) {
            const updatedJob = { ...existingJob, ...data };
            await kv.set(["tutor_jobs", data.id], updatedJob);
            return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "无权编辑或岗位不存在" }), { status: 403, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "编辑失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 删除岗位
    if (req.method === "POST" && url.pathname === "/api/tutor/job/delete") {
      try {
        const { id } = await req.json();
        if (kv) {
          const jobRes = await kv.get(["tutor_jobs", id]);
          const job = jobRes.value as any;
          if (job && (job.publisherEmail === userEmail || isAdmin)) {
            await kv.delete(["tutor_jobs", id]);
            sendTutorWeWorkNotification("delete", job);
            return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "无权删除或岗位不存在" }), { status: 403, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "删除失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 接单
    if (req.method === "POST" && url.pathname === "/api/tutor/job/accept") {
      try {
        const { id, name, phone } = await req.json();
        if (kv) {
          const jobRes = await kv.get(["tutor_jobs", id]);
          const job = jobRes.value as any;
          if (job && job.status === "open") {
            job.status = "accepted";
            job.acceptedByEmail = userEmail;
            job.acceptedByName = name;
            job.acceptedByPhone = phone;
            await kv.set(["tutor_jobs", id], job);
            sendTutorWeWorkNotification("apply", { jobTitle: job.subject, name, phone });
            return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "岗位已被接单或不存在" }), { status: 400, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "接单失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 取消接单 (退回大厅)
    if (req.method === "POST" && url.pathname === "/api/tutor/job/cancel") {
      try {
        const { id } = await req.json();
        if (kv) {
          const jobRes = await kv.get(["tutor_jobs", id]);
          const job = jobRes.value as any;
          if (job && job.status === "accepted" && job.acceptedByEmail === userEmail) {
            job.status = "open";
            const acceptedByName = job.acceptedByName;
            const acceptedByPhone = job.acceptedByPhone;
            job.acceptedByEmail = null;
            job.acceptedByName = null;
            job.acceptedByPhone = null;
            await kv.set(["tutor_jobs", id], job);
            sendTutorWeWorkNotification("cancel_apply", { jobTitle: job.subject, name: acceptedByName, phone: acceptedByPhone });
            return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "操作失败" }), { status: 400, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "取消失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }
  }

  // 6. 自习室 API
  if (url.pathname.startsWith("/api/study-room/")) {
    
    // 获取当前有效的预定记录
    if (req.method === "GET" && url.pathname === "/api/study-room/reservations") {
      if (!kv) return new Response(JSON.stringify({ success: false, error: "KV不可用" }), { status: 500, headers: JSON_HEADERS });

      try {
        const reservations = [];
        // 获取所有预定记录
        for await (const entry of kv.list({ prefix: ["study_room_reservations"] })) {
          const res = entry.value as any;
          reservations.push(res);
        }
        
        // 排序：按预约日期和时间段
        reservations.sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          if (a.timeSlot !== b.timeSlot) return a.timeSlot.localeCompare(b.timeSlot);
          return 0;
        });

        // 脱敏处理，保护隐私
        const publicReservations = reservations.map(r => ({
          id: r.id,
          date: r.date,
          timeSlot: r.timeSlot,
          userEmail: r.userEmail,
          // 将姓名处理为 "张**" 或 "张老师" 格式
          name: r.name.length > 1 ? r.name.charAt(0) + '*'.repeat(r.name.length - 1) : r.name
        }));

        return new Response(JSON.stringify({ success: true, data: publicReservations }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "获取预定数据失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 提交新的预定
    if (req.method === "POST" && url.pathname === "/api/study-room/reserve") {
      const userEmail = await getUserEmail(req);
      if (!userEmail) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), { status: 401, headers: JSON_HEADERS });
      }

      try {
        const data = await req.json();
        const { selectedSlots, name, phone } = data;
        
        if (!selectedSlots || !Array.isArray(selectedSlots) || selectedSlots.length === 0 || !name || !phone) {
           return new Response(JSON.stringify({ success: false, error: "请选择时间并填写完整预定信息" }), { status: 400, headers: JSON_HEADERS });
        }

        if (kv) {
          // 检查时间段是否已被预定
          let isConflict = false;
          let conflictMsg = "";
          
          const existingReservations = [];
          for await (const entry of kv.list({ prefix: ["study_room_reservations"] })) {
             existingReservations.push(entry.value as any);
          }

          for (const slot of selectedSlots) {
              const conflict = existingReservations.find(r => r.date === slot.date && r.timeSlot === slot.timeSlot);
              if (conflict) {
                  isConflict = true;
                  conflictMsg = `${slot.date} 的 ${slot.timeSlot}`;
                  break;
              }
          }

          if (isConflict) {
             return new Response(JSON.stringify({ success: false, error: `${conflictMsg} 已被预定，请重新选择` }), { status: 409, headers: JSON_HEADERS });
          }

          // 批量存储
          const createdAt = new Date().toISOString();
          let timeSlotsStr = "";

          for (const slot of selectedSlots) {
              const id = crypto.randomUUID();
              const reservation = {
                id,
                userEmail,
                date: slot.date,
                timeSlot: slot.timeSlot,
                name,
                phone,
                createdAt
              };
              await kv.set(["study_room_reservations", id], reservation);
              timeSlotsStr += `> - <font color="info">${slot.date}</font> ${slot.timeSlot}\n`;
          }
          
          try {
             await sendStudyRoomWeWorkNotification('reserve', {
                name,
                phone,
                timeSlotsStr
             });
          } catch(e) {
             console.error("自习室预定通知发送失败:", e);
          }
          
          return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify({ success: false, error: "KV不可用" }), { status: 500, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "预定失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 取消预定
    if (req.method === "POST" && url.pathname === "/api/study-room/cancel") {
      const userEmail = await getUserEmail(req);
      if (!userEmail) {
        return new Response(JSON.stringify({ success: false, error: "未登录" }), { status: 401, headers: JSON_HEADERS });
      }

      try {
        const { id } = await req.json();
        
        if (kv) {
          const res = await kv.get(["study_room_reservations", id]);
          const reservation = res.value as any;
          
          if (!reservation) {
            return new Response(JSON.stringify({ success: false, error: "预定记录不存在" }), { status: 404, headers: JSON_HEADERS });
          }

          if (reservation.userEmail !== userEmail) {
            return new Response(JSON.stringify({ success: false, error: "无权取消他人的预定" }), { status: 403, headers: JSON_HEADERS });
          }

          await kv.delete(["study_room_reservations", id]);
          
          const timeSlotsStr = `> - <font color="warning">${reservation.date}</font> ${reservation.timeSlot}\n`;
          
          try {
             await sendStudyRoomWeWorkNotification('cancel', {
                name: reservation.name,
                phone: reservation.phone,
                timeSlotsStr
             });
          } catch(e) {
             console.error("自习室取消通知发送失败:", e);
          }

          return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify({ success: false, error: "KV不可用" }), { status: 500, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "取消失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }
  }

  // 7. 处理其他未匹配的路由
  return new Response("Not Found - 雅宝教育工作室", { status: 404 });
});
