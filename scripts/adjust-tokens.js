#!/usr/bin/env node

/**
 * 调整样本文件的token数量到目标范围
 * 目标: 7.7K - 7.9K tokens
 */

import { encode, decode } from 'gpt-tokenizer';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const dataDir = join(process.cwd(), 'data');
const TARGET_MIN = 7700;
const TARGET_MAX = 7900;

// 用于填充的内容模板
const FILLER_TEMPLATE = `
## 补充说明

### 最佳实践建议

在实际应用中，需要注意以下几点：

**性能优化**：合理配置资源，监控系统状态，及时发现和处理问题。使用缓存减少重复计算，优化算法提高处理效率。

**安全考虑**：保护敏感数据，实施访问控制，定期安全审计。遵循最小权限原则，及时更新安全补丁。

**可扩展性设计**：系统架构应该支持水平扩展，能够应对业务增长。使用微服务架构可以提高系统的灵活性和可维护性。

**监控与告警**：建立完善的监控体系，实时监控系统状态。配置合理的告警规则，及时发现和处理异常情况。

**文档与知识管理**：编写清晰的技术文档，建立知识库。团队成员之间共享知识，提高整体技术水平。

### 常见问题与解决方案

**问题1：系统响应缓慢**

可能原因：资源不足、查询效率低、网络延迟等。

解决方案：优化数据库查询，增加缓存，使用CDN加速，合理配置资源。

**问题2：数据一致性问题**

可能原因：分布式系统的特性导致。

解决方案：使用分布式事务，最终一致性模型，合理设计数据同步策略。

**问题3：安全漏洞**

可能原因：输入验证不充分，权限控制不严格。

解决方案：加强输入验证，实施严格的权限控制，定期安全扫描。

### 发展趋势与展望

随着技术的不断发展，该领域正在快速演进。新技术的出现为解决传统问题提供了新的思路和方法。

人工智能技术的应用正在改变传统的开发模式，自动化程度越来越高。开发者需要不断学习新技术，适应技术变革。

云原生技术正在成为主流，容器化、微服务、服务网格等技术越来越成熟。企业需要拥抱云原生，提高开发效率和应用可靠性。

开源社区的发展推动了技术创新，越来越多的优质开源项目涌现。参与开源社区，贡献代码，是提高技术能力的有效途径。

---

*本节内容补充了相关的最佳实践、常见问题和发展趋势，帮助读者更好地理解和应用所学知识。*
`;

// 获取所有sample文件
const files = readdirSync(dataDir)
  .filter(f => f.startsWith('sample-8k') && f.endsWith('.txt'))
  .sort();

console.log('样本文件Token调整报告\n');
console.log('目标范围: 7,700 - 7,900 tokens\n');
console.log('=' .repeat(70));
console.log('文件名'.padEnd(25) + '当前Token'.padStart(12) + '目标Token'.padStart(12) + '操作'.padStart(15));
console.log('-'.repeat(70));

for (const file of files) {
  const filePath = join(dataDir, file);
  const content = readFileSync(filePath, 'utf-8');
  const tokens = encode(content);
  const currentTokens = tokens.length;
  
  let action = '';
  let newTokens = currentTokens;
  
  if (currentTokens < TARGET_MIN) {
    action = `需要增加 ${TARGET_MIN - currentTokens}`;
    newTokens = TARGET_MIN;
  } else if (currentTokens > TARGET_MAX) {
    action = `需要减少 ${currentTokens - TARGET_MAX}`;
    newTokens = TARGET_MAX;
  } else {
    action = '符合要求';
  }
  
  console.log(file.padEnd(25) + currentTokens.toString().padStart(12) + newTokens.toString().padStart(12) + action.padStart(15));
}

console.log('='.repeat(70));

// 提供调整建议
console.log('\n调整建议:');
console.log('-'.repeat(70));

for (const file of files) {
  const filePath = join(dataDir, file);
  const content = readFileSync(filePath, 'utf-8');
  const tokens = encode(content);
  const currentTokens = tokens.length;
  
  if (currentTokens < TARGET_MIN) {
    const needed = TARGET_MIN - currentTokens;
    const fillerTokens = encode(FILLER_TEMPLATE).length;
    const repetitions = Math.ceil(needed / fillerTokens);
    console.log(`\n${file}: 需要增加 ${needed} tokens`);
    console.log(`  建议: 在文件末尾添加 ${repetitions} 次补充内容模板`);
  } else if (currentTokens > TARGET_MAX) {
    const excess = currentTokens - TARGET_MAX;
    console.log(`\n${file}: 需要减少 ${excess} tokens`);
    console.log(`  建议: 删减末尾约 ${Math.round(excess * 4)} 个字符的内容`);
  }
}

// 输出填充模板的token数
console.log('\n填充模板信息:');
console.log(`- 补充内容模板token数: ${encode(FILLER_TEMPLATE).length}`);

// 如果指定了 --apply 参数，则实际执行调整
if (process.argv.includes('--apply')) {
  console.log('\n开始执行调整...\n');
  
  for (const file of files) {
    const filePath = join(dataDir, file);
    let content = readFileSync(filePath, 'utf-8');
    const tokens = encode(content);
    const currentTokens = tokens.length;
    
    let newContent = content;
    let newTokens = currentTokens;
    
    if (currentTokens < TARGET_MIN) {
      // 需要增加内容
      const needed = TARGET_MIN - currentTokens;
      const fillerTokens = encode(FILLER_TEMPLATE).length;
      let addedTokens = 0;
      
      while (addedTokens < needed) {
        newContent += FILLER_TEMPLATE;
        addedTokens += fillerTokens;
      }
      
      // 精确调整到目标值
      const finalTokens = encode(newContent);
      if (finalTokens.length > TARGET_MAX) {
        // 删除多余的tokens
        const tokenArray = encode(newContent);
        const trimmedTokens = tokenArray.slice(0, TARGET_MAX);
        newContent = decode(trimmedTokens);
      }
      
    } else if (currentTokens > TARGET_MAX) {
      // 需要减少内容
      const tokenArray = encode(content);
      const trimmedTokens = tokenArray.slice(0, TARGET_MAX);
      newContent = decode(trimmedTokens);
    }
    
    newTokens = encode(newContent).length;
    
    if (newContent !== content) {
      writeFileSync(filePath, newContent, 'utf-8');
      console.log(`${file}: ${currentTokens} -> ${newTokens} tokens`);
    } else {
      console.log(`${file}: 无需调整 (${currentTokens} tokens)`);
    }
  }
  
  console.log('\n调整完成!');
} else {
  console.log('\n提示: 使用 --apply 参数执行实际调整');
}