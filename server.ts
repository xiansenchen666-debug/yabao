// server.ts
// 雅宝教育工作室 V4版本 - Deno Deploy (前后端分离)

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const MOBILE_PHONE_REGEX = /^1\d{10}$/;
const LANDLINE_PHONE_REGEX = /^0\d{2,3}-?\d{7,8}$/;

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePhone(value: unknown) {
  return normalizeText(value).replace(/\s+/g, "");
}

function isValidPhone(phone: string) {
  return MOBILE_PHONE_REGEX.test(phone) || LANDLINE_PHONE_REGEX.test(phone);
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
async function sendTutorWeWorkNotification(type: 'post' | 'apply', data: any) {
  // 使用你新提供的兼职专属 webhook
  const tutorWebhookUrl = Deno.env.get("TUTOR_WEWORK_WEBHOOK_URL") || "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=079e2b50-fa4d-4e85-9e27-9bd6a8c028a0";
  
  let content = "";
  if (type === 'post') {
    content = `📢 **新家教需求发布**\n> 📍 地址：<font color="info">${data.address}</font>\n> 🎓 年级：<font color="info">${data.grade}</font>\n> 📚 科目：<font color="info">${data.subject}</font>\n> 💰 费用：<font color="warning">${data.fee}</font>\n> 🕒 时间：${data.time}\n> 👨‍🎓 学生情况：${data.studentInfo}\n> 👩‍🏫 老师要求：${data.requirement}\n> 📝 备注：${data.remark}\n> ⏰ 提交时间：${formatToBeijingTime()}`;
  } else if (type === 'apply') {
    content = `🎯 **新老师接单申请**\n> 🏷️ 申请岗位：<font color="info">${data.jobTitle}</font>\n> 👤 老师姓名：<font color="info">${data.name}</font>\n> 📞 联系电话：<font color="warning">${data.phone}</font>\n> ⏰ 申请时间：${formatToBeijingTime()}`;
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
      console.log(`[家教通知成功] ${type === 'post' ? '发布需求' : '接单申请'}已推送到兼职专属企微群`);
    }
  } catch (error) {
    console.error("[家教通知异常] 发生错误:", error);
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
    return res.value as string | null;
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

  // 5. 兼职平台核心 API
  if (url.pathname.startsWith("/api/tutor/")) {
    
    // 发送验证码
    if (req.method === "POST" && url.pathname === "/api/tutor/send-code") {
      try {
        const { email } = await req.json();
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

    // 登录并换取 Token
    if (req.method === "POST" && url.pathname === "/api/tutor/login") {
      try {
        const { email, code } = await req.json();
        
        if (!email || !email.includes('@')) {
          return new Response(JSON.stringify({ success: false, error: "邮箱格式不正确" }), { status: 400, headers: JSON_HEADERS });
        }
        
        if (!code || code.length !== 6) {
          return new Response(JSON.stringify({ success: false, error: "请输入6位验证码" }), { status: 400, headers: JSON_HEADERS });
        }

        // 【测试模式】允许任意 6 位数字验证码直接登录
        console.log(`[测试模式] ${email} 使用任意验证码 ${code} 登录成功`);
        
        if (kv) {
          // 清理可能存在的真实验证码记录
          await kv.delete(["tutor_auth_codes", email]);
          const token = crypto.randomUUID();
          await kv.set(["tutor_tokens", token], email);
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
      const isAdmin = userEmail === "admin@yabao.com";
      
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
    const isAdmin = userEmail === "admin@yabao.com";

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
            job.acceptedByEmail = null;
            job.acceptedByName = null;
            job.acceptedByPhone = null;
            await kv.set(["tutor_jobs", id], job);
            return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "操作失败" }), { status: 400, headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "取消失败" }), { status: 500, headers: JSON_HEADERS });
      }
    }
  }

  // 6. 处理其他未匹配的路由
  return new Response("Not Found - 雅宝教育工作室", { status: 404 });
});
