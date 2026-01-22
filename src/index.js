// 仅使用Node.js内置模块：http/https/url/querystring/fs/path
const https = require('node:https');
const url = require('node:url');
const querystring = require('node:querystring');

// 1. 工具函数：发送HTTP请求（替代axios，零依赖）
function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data)); // 默认解析JSON
          } catch (err) {
            resolve(data); // 非JSON直接返回字符串
          }
        } else {
          reject(new Error(`HTTP请求失败：${res.statusCode}，响应：${data}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

// 2. 工具函数：获取昨日时间范围（UTC，替代dayjs）
function getYesterdayTimeRange() {
  const now = new Date();
  // 昨日0点（UTC）
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
  // 昨日23:59:59（UTC）
  const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
  return {
    start: yesterdayStart.toISOString(),
    end: yesterdayEnd.toISOString()
  };
}

// 3. 工具函数：判断时间是否在指定范围内（替代dayjs的isBetween）
function isTimeBetween(timeStr, startStr, endStr) {
  const time = new Date(timeStr);
  const start = new Date(startStr);
  const end = new Date(endStr);
  return time >= start && time <= end;
}

// 4. 工具函数：发送钉钉Webhook（零依赖）
async function sendDingTalkWebhook(webhookUrl, content) {
  const parsedUrl = url.parse(webhookUrl);
  const postData = JSON.stringify({
    msgtype: 'markdown',
    markdown: {
      title: 'GitHub仓库每日监控报告',
      text: content
    }
  });

  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  await request(options, postData);
}

// 5. 核心：获取GitHub仓库数据（Release/Issue/评论）
async function getGitHubRepoData(repo, token) {
  const timeRange = getYesterdayTimeRange();
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  // 5.1 获取昨日Release列表
  const releaseOptions = {
    hostname: 'api.github.com',
    path: `/repos/${repo}/releases?${querystring.stringify({ since: timeRange.start, per_page: 100 })}`,
    method: 'GET',
    headers: { ...headers, 'User-Agent': 'Node.js GH Monitor' } // GitHub要求必须带User-Agent
  };
  const releases = await request(releaseOptions);
  const yesterdayReleases = releases.filter(r => isTimeBetween(r.created_at, timeRange.start, timeRange.end));

  // 5.2 获取昨日Issue列表（排除PR）
  const issueOptions = {
    hostname: 'api.github.com',
    path: `/repos/${repo}/issues?${querystring.stringify({ since: timeRange.start, state: 'all', per_page: 100, filter: 'all' })}`,
    method: 'GET',
    headers: { ...headers, 'User-Agent': 'Node.js GH Monitor' }
  };
  const issues = await request(issueOptions);
  const yesterdayIssues = issues.filter(i => !i.pull_request && isTimeBetween(i.created_at, timeRange.start, timeRange.end));

  // 5.3 获取每个Issue的评论
  const issuesWithComments = [];
  for (const issue of yesterdayIssues) {
    const commentOptions = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues/${issue.number}/comments`,
      method: 'GET',
      headers: { ...headers, 'User-Agent': 'Node.js GH Monitor' }
    };
    // 限流延迟：200ms
    await new Promise(resolve => setTimeout(resolve, 200));
    const comments = await request(commentOptions);
    issuesWithComments.push({
      ...issue,
      comments: comments.map(c => ({
        author: c.user.login,
        body: c.body,
        created_at: c.created_at
      }))
    });
  }

  return {
    releases: yesterdayReleases.map(r => ({
      tag_name: r.tag_name,
      name: r.name,
      body: r.body,
      created_at: r.created_at
    })),
    issues: issuesWithComments
  };
}

// 6. 主函数
async function main() {
  try {
    // 配置参数（从环境变量读取）
    const SUBSCRIBE_LIST_URL = process.env.SUBSCRIBE_LIST_URL; // 公网OSS的JSON地址
    const GITHUB_TOKEN = process.env.GLOBAL_TOKEN;
    const LLM_API_URL = process.env.LLM_API_URL;

    if (!SUBSCRIBE_LIST_URL || !GITHUB_TOKEN || !LLM_API_URL) {
      throw new Error('缺少必要环境变量：SUBSCRIBE_LIST_URL/GITHUB_TOKEN/LLM_API_URL');
    }

    // 6.1 读取公网订阅列表（JSON）
    console.log('读取订阅列表：', SUBSCRIBE_LIST_URL);
    const parsedSubUrl = url.parse(SUBSCRIBE_LIST_URL);
    const subscribeOptions = {
      hostname: parsedSubUrl.hostname,
      path: parsedSubUrl.path,
      method: 'GET',
      headers: { 'User-Agent': 'Node.js GH Monitor' }
    };
    const subscribeList = await request(subscribeOptions);
    if (!Array.isArray(subscribeList) || subscribeList.length === 0) {
      console.log('无订阅仓库，执行结束');
      return;
    }

    // 6.2 遍历每个订阅仓库
    for (const item of subscribeList) {
      const { repo, dingTalkWebhook } = item;
      if (!repo) {
        console.log('仓库名称为空，跳过');
        continue;
      }
      console.log(`开始处理仓库：${repo}`);

      // 6.3 获取GitHub数据
      const repoData = await getGitHubRepoData(repo, GITHUB_TOKEN);

      // 6.4 构造LLM请求数据
      const llmRequestData = {
        repo,
        date: new Date(new Date().setDate(new Date().getDate() - 1)).toISOString().split('T')[0], // 昨日日期 YYYY-MM-DD
        releases: repoData.releases,
        issues: repoData.issues
      };

      // 6.5 调用LLM接口
      let llmResponse = '';
      try {
        const parsedLlmUrl = url.parse(LLM_API_URL);
        const llmOptions = {
          hostname: parsedLlmUrl.hostname,
          path: parsedLlmUrl.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(llmRequestData))
          }
        };
        const llmRes = await request(llmOptions, llmRequestData);
        llmResponse = llmRes.content || JSON.stringify(llmRes, null, 2);
      } catch (err) {
        console.error(`调用LLM失败：${err.message}，使用原始数据`);
        // 格式化原始数据为钉钉Markdown
        llmResponse = `### ${repo} 昨日监控报告
- Release数量：${repoData.releases.length}
${repoData.releases.map(r => `- 🚀 ${r.tag_name}：${r.name || '无标题'}`).join('\n')}

- Issue数量：${repoData.issues.length}
${repoData.issues.map(i => `- 📝 #${i.number} ${i.title}（评论数：${i.comments.length}）`).join('\n')}
`;
      }

      // 6.6 发送钉钉通知
      if (dingTalkWebhook) {
        console.log(`发送钉钉通知：${dingTalkWebhook}`);
        await sendDingTalkWebhook(dingTalkWebhook, llmResponse);
      } else {
        console.log(`仓库${repo}无钉钉Webhook，跳过`);
      }
      console.log(`仓库${repo}处理完成\n`);
    }

    console.log('所有仓库处理完成');
  } catch (err) {
    console.error('脚本执行失败：', err.message);
    process.exit(1);
  }
}

// 执行主函数
main();
