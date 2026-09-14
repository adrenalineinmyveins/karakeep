/** C1 资产导出/导入的浏览器端小工具（三处管理页共用） */

/** 触发浏览器下载一个 JSON 文件 */
export function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 读用户选择的 JSON 文件（解析失败 reject） */
export function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((text) => JSON.parse(text));
}

/** 文件名里的名字做最小清洗（去掉路径/非法字符） */
export function safeFilenamePart(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/-+/g, "-");
  return cleaned.slice(0, 60) || "asset";
}
