// server.ts
// 雅宝教育工作室 V4版本 - Deno Deploy (前后端分离)

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
    let data;
    try {
      data = await req.json();
    } catch (error) {
      console.error("解析请求JSON失败:", error);
      return new Response(
        JSON.stringify({ success: false, error: "无效的请求数据格式" }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    
    // 简单的数据校验
    if (!data.name || !data.phone) {
      return new Response(
        JSON.stringify({ success: false, error: "姓名和电话为必填项" }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

    // 生成唯一预约 ID
    const appointmentId = crypto.randomUUID();
    
    // 构造要存储的数据结构
    const appointmentRecord = {
      id: appointmentId,
      name: data.name,
      phone: data.phone,
      course: data.course || "未指定",
      createdAt: new Date().toISOString(),
      status: "pending" // 初始状态为待处理
    };

    // 存入 Deno KV (如果可用)，否则记录到日志中
    if (kv) {
      try {
        await kv.set(["appointments", appointmentId], appointmentRecord);
        console.log(`[KV存储成功] 新预约信息: ${data.name} (${data.phone}) - ${data.course}`);
      } catch (kvError) {
        console.error(`[KV存储失败] 无法写入数据:`, kvError);
        console.log(`[降级记录] 新预约信息: ${data.name} (${data.phone}) - ${data.course}`);
      }
    } else {
      console.log(`[模拟存储] 新预约信息: ${data.name} (${data.phone}) - ${data.course} (提示：当前环境未连接真实 KV 数据库)`);
    }

    // 返回成功响应
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "预约信息已成功提交！",
        id: appointmentId
      }),
      { 
        status: 201, 
        headers: { "content-type": "application/json" } 
      }
    );
  }

  // 3. 处理其他未匹配的路由
  return new Response("Not Found - 雅宝教育工作室", { status: 404 });
});
