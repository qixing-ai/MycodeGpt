import {defineStore} from 'pinia';
import {message} from 'ant-design-vue';
import {eventBus} from '@/eventBus.js';
import {Modal} from 'ant-design-vue';

const {ipcRenderer} = require('electron');

export const useMessageStore = defineStore('message_store', {
    state: () => ({
        sessions: [],
    }),
    persist: {
        enabled: true,
        strategies: [
            {
                key: 'message_store',
                storage: localStorage,
            },
        ],
    },
    actions: {
        createSession(models, projects) {
            const newSession = {
                sessionId: Date.now(),
                currentModel: models,
                messages: [
                    {
                        role: 'system',
                        content: `\`\`\`json\n${JSON.stringify(projects, null, 2)}\n\`\`\``,
                        isAnalyzing: false,
                    },
                ],
            };
            this.sessions.push(newSession);
            return newSession
        },
        async selectFileAndChat(currentSession, index, overwrite, semanticSearch = false) {
            if (!currentSession.currentModel) {
                message.error('请选择一个模型');
                return;
            }

            const messagelist = currentSession.messages
            const userQuestion = messagelist[index].content;
            const prompt = `
返回的 JSON 数据结构为：
{
    "analysis": "...",
    "result": {
        "reason": ["选择...文件的原因...", "..."],
        "filePath": ["文件路径...", "..."]
        "needContent": true/false,
    }
}

JSON结构说明:
analysis: 用户意图分析,根据问题和上文的信息...,system中定义类每个文件的简单信息,没有相关文件的具体内容
reason: 如果needContent=false,就不用选择文件, 如果needContent=true,就需要将关联的所有文件的原因写出来
filePath: 相关文件的路径
needContent: 判断如果上文中已经存在相关文件的具体内容就false, 如果不存在就true, 一般为true

问题如下：${userQuestion}

`;
            const clonedMessages = JSON.parse(JSON.stringify(messagelist));
            clonedMessages[index].content = prompt;
            await this.processChat(currentSession, clonedMessages, index, overwrite, semanticSearch);

            const assistantResponse = currentSession.messages[index + 1]?.content || '';
            const matches = assistantResponse.match(/```json([\s\S]*?)```/);
            const jsonResponse = matches ? JSON.parse(matches[1].trim()) : null;
            if (!jsonResponse) return;

            if (jsonResponse.result.needContent) {
                const files = jsonResponse.result.filePath || [];
                if (!files.length) return;

                const combinedContent = await this.getCombinedFileContent(files);
                if (!combinedContent) return;

                const newPrompt = `
${combinedContent}

请基于这些内容回答用户的问题: ${userQuestion}

返回的 JSON 数据结构为：
{
    "思考": "...",
    "反思": "...",
    "再思考": "...",
    "结果": [
        {
            "filePath": "...",
            "totleContent": true,
            "code": "..."
        }
        ,...
    ]
}

JSON结构说明:
你是一个使用链式思维（Chain of Thought，CoT）方法并结合反思来回答问题的 AI 助手。
思考：按步骤思考并分析问题，提出相关的解决方案。
反思：反思上面的思考推理过程，检查是否有错误或改进空间。
再思考：根据你的反思做出必要的调整，提出更完善的解决方案。
结果：提供最终的简洁答案,如果是多个文件的代码就返回多个

- **当 \`totleContent=true\`**：返回完整的代码内容。
- **当 \`totleContent=false\`**：返回 Git diff 格式的部分修改内容，格式如下：
@@ -startLine,numberOfOriginalLines +startLine,numberOfNewLines @@
 context lines (unchanged lines)
-deleted line
+added line
startLine 是修改起始行号。
numberOfOriginalLines 是原始文件中显示的上下文加上被修改的行数。
numberOfNewLines 是修改后的文件中显示的上下文加上被修改的行数。
`;
                messagelist.splice(index + 2, 0, {role: 'user', content: newPrompt});
                await this.processChat(currentSession, currentSession.messages, index + 2, overwrite, semanticSearch);
                this.messageExecuteCode(index + 3)
            }
            if (!jsonResponse.result.needContent) {
                await this.processChat(currentSession, currentSession.messages, index, overwrite, semanticSearch);
                this.messageExecuteCode(currentSession.sessionId, index)
            }
        },
        async getCombinedFileContent(files) {
            try {
                const contents = await Promise.all(
                    files.map(async (file) => {
                        const info = await ipcRenderer.invoke('get-one-file', file);
                        const fileType = file.split('.').pop();
                        return `${file}:\n\`\`\`${fileType} \n${info.content}\n\`\`\` \n`;
                    })
                );
                return contents.join('');
            } catch (error) {
                console.error('获取文件内容失败:', error);
                return '';
            }
        },
        async processChat(currentSession, messagelist, index, overwrite, semanticSearch = false) {
            currentSession.isStreaming = true;
            if (semanticSearch) {
                //  todo 检索
            }
            const modelPayload = {
                ...currentSession.currentModel,
                stream: true,
                messages: messagelist,
            };

            const response = await fetch(
                `${modelPayload.baseUrl.replace(/\/?$/, '/')}${'v1/chat/completions'}`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${modelPayload.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(modelPayload),
                }
            );

            currentSession.reader = response.body.getReader();
            const decoder = new TextDecoder();
            const assistantIndex = overwrite ? index : index + 1;
            currentSession.messages[assistantIndex] = {
                role: 'assistant',
                content: '',
                isAnalyzing: true,
            };

            while (true) {
                const {done, value} = await currentSession.reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                currentSession.messages[assistantIndex].content += this.parseChatResponse(chunk);
                eventBus.emit('messageUpdated', assistantIndex);
            }

            currentSession.messages[assistantIndex].isAnalyzing = false;
            currentSession.isStreaming = false;
        },
        parseChatResponse(input) {
            return input
                .split('data:')
                .map((part) => part.trim())
                .filter((part) => part && part !== '[DONE]')
                .reduce((acc, part) => {
                    try {
                        const json = JSON.parse(part);
                        if (json.choices?.[0]?.delta?.content) {
                            acc += json.choices[0].delta.content;
                        }
                    } catch (error) {
                        console.error('解析 JSON 失败:', error, '错误的数据:', part);
                    }
                    return acc;
                }, '');
        },
        // 在您的 actions 中添加或替换以下方法
        async messageExecuteCode(selectedSessionId, index) {
            const currentSession = this.sessions.find(s => s.sessionId === selectedSessionId)
            const assistantMessage = currentSession.messages[index]?.content;
            if (!assistantMessage) return;

            // 尝试从消息中提取 JSON 响应
            const matches = assistantMessage.match(/```json([\s\S]*?)(?:\n```|$)/);
            let jsonResponse = '';
            try {
                if (matches) {
                    jsonResponse = JSON.parse(matches[1].trim());
                } else {
                    jsonResponse = JSON.parse(assistantMessage.trim());
                }
            } catch (error) {
                console.log('解析 JSON 时发生错误: ' + error.message);
                console.log(assistantMessage);
            }
            if (!jsonResponse) {
                message.success('不是代码无需运行');
                return;
            }

            // 从 JSON 响应中获取文件路径、代码内容和 totleContent
            const {思考, 反思, 再思考, 结果} = jsonResponse;

            if (!Array.isArray(结果) || 结果.length === 0) {
                console.log('JSON 结果列表为空或无效');
                return;
            }

            // 遍历结果列表
            for (const item of 结果) {
                if (!item.filePath || !item.code || typeof item.totleContent !== 'boolean') {
                    console.log('JSON 结果中缺少文件路径、代码内容或 totleContent');
                    continue; // 跳过当前项，处理下一个
                }

                const filePath = item.filePath;
                let codeContent = item.code;
                const totleContent = item.totleContent;

                // 替换文件内容
                try {
                    let result;
                    if (totleContent) {
                        // 替换整个文件内容
                        result = await ipcRenderer.invoke('replace-file-content', filePath, codeContent);
                    } else {
                        // 应用 git diff 补丁
                        result = await ipcRenderer.invoke('replace-file-content-diff', filePath, codeContent);
                    }

                    if (result.success) {
                        message.success(`文件 ${filePath} 已成功更新`);
                    } else {
                        codeContent = codeContent
                            .split('\n')
                            .map(line => line.startsWith('-') || line.startsWith('+') ? line.slice(1) : line) // 移除 `-` 和 `+`
                            .join('\n');
                        Modal.info({
                            title: `更新文件 ${filePath} 时出错:${result.message}`,
                            content: codeContent,
                            width: 800,
                            okText: '复制',
                            cancelText: '关闭',
                            maskClosable: true,
                            onOk() {
                                navigator.clipboard.writeText(codeContent).then(() => {
                                    message.success('代码已复制到剪贴板');
                                });
                            }
                        });
                    }
                } catch (error) {
                    message.error(`调用替换文件内容时出错: ${error.message}`);
                }
            }
        },
        async stopChat(currentSession) {
            if (currentSession.isStreaming) {
                await currentSession.reader?.cancel();
                currentSession.isStreaming = false;
                eventBus.emit('messageUpdated', null);
                message.success('请求已终止');
            } else {
                message.info('当前没有正在进行的流式请求');
            }
        },
    },
});
