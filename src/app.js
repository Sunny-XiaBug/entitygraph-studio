const dictionary = [
  { text: "University of California, Los Angeles", type: "ORG" },
  { text: "未来科技公司", type: "ORG" },
  { text: "Steve Jobs", type: "PERSON" },
  { text: "Elon Musk", type: "PERSON" },
  { text: "Los Angeles", type: "LOC" },
  { text: "California", type: "LOC" },
  { text: "Microsoft", type: "ORG" },
  { text: "LinkedIn", type: "ORG" },
  { text: "Apple", type: "ORG" },
  { text: "Tesla", type: "ORG" },
  { text: "Austin", type: "LOC" },
  { text: "张三", type: "PERSON" },
  { text: "北京", type: "LOC" },
];

const samples = [
  "Steve Jobs founded Apple in California.",
  "Elon Musk is the CEO of Tesla, which is headquartered in Austin.",
  "张三创立了未来科技公司，该公司总部位于北京。",
  "University of California, Los Angeles is located in Los Angeles.",
];

const defaultText = [
  "Steve Jobs founded Apple in California.",
  "Apple is headquartered in California.",
  "Elon Musk is the CEO of Tesla, which is headquartered in Austin.",
  "Microsoft acquired LinkedIn.",
].join(" ");

const typeLabels = {
  PERSON: "PERSON",
  ORG: "ORG",
  LOC: "LOC",
  UNKNOWN: "UNKNOWN",
};

const graphColors = {
  PERSON: { background: "#dbeafe", border: "#2563eb" },
  ORG: { background: "#dcfce7", border: "#16a34a" },
  LOC: { background: "#ffedd5", border: "#f97316" },
  UNKNOWN: { background: "#f1f5f9", border: "#64748b" },
};

let network;
let currentResult;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanMention(value) {
  return value.replace(/^[\s,，。.;；:：]+|[\s,，。.;；:：]+$/g, "").replace(/\s+/g, " ");
}

function normalizeMention(value) {
  return cleanMention(value).toLowerCase();
}

function addRegexEntities(text, entities, regex, type, group = 1) {
  for (const match of text.matchAll(regex)) {
    const value = match[group];
    if (!value) continue;
    const offset = match.index + match[0].indexOf(value);
    entities.push({
      text: text.slice(offset, offset + value.length),
      type,
      start: offset,
      end: offset + value.length,
    });
  }
}

function dedupeAndSelectLongest(entities) {
  const unique = new Map();
  for (const entity of entities) {
    unique.set(`${entity.start}:${entity.end}:${entity.type}`, entity);
  }

  const selected = [];
  const sorted = [...unique.values()].sort((a, b) => {
    const lengthDelta = b.end - b.start - (a.end - a.start);
    return lengthDelta || a.start - b.start;
  });

  for (const entity of sorted) {
    const overlaps = selected.some(
      (chosen) => entity.start < chosen.end && entity.end > chosen.start,
    );
    if (!overlaps) selected.push(entity);
  }

  return selected.sort((a, b) => a.start - b.start || a.end - b.end);
}

function extractEntities(text) {
  const entities = [];

  for (const item of dictionary) {
    const flags = /[\u4e00-\u9fff]/.test(item.text) ? "g" : "gi";
    const regex = new RegExp(escapeRegExp(item.text), flags);
    for (const match of text.matchAll(regex)) {
      entities.push({
        text: text.slice(match.index, match.index + match[0].length),
        type: item.type,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const englishRules = [
    [/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:founded|created)\b/gi, "PERSON"],
    [/\b(?:founded|created|acquired)\s+([A-Z][A-Za-z]*(?:\s+(?!in\b|which\b|is\b|the\b|of\b)[A-Z][A-Za-z]*)*)\b/gi, "ORG"],
    [/\b(?:in|located\s+in|headquartered\s+in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/gi, "LOC"],
    [/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+is\s+the\s+CEO\s+of\b/gi, "PERSON"],
    [/\bCEO\s+of\s+([A-Z][A-Za-z]*(?:\s+(?!which\b|is\b|the\b|of\b)[A-Z][A-Za-z]*)*)\b/gi, "ORG"],
    [/\b([A-Z][A-Za-z]*(?:\s+(?!is\b)[A-Z][A-Za-z]*)*)\s+is\s+headquartered\s+in\b/gi, "ORG"],
    [/\b((?:University|College|Institute)\s+of\s+[A-Z][A-Za-z]+(?:,\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)*)\s+is\s+located\b/gi, "ORG"],
  ];

  for (const [regex, type] of englishRules) {
    addRegexEntities(text, entities, regex, type);
  }

  const chineseRules = [
    [/([\u4e00-\u9fa5]{2,4})(?:创立|创建|创办)/g, "PERSON"],
    [/(?:创立了?|创建了?|创办了?|收购了?)([\u4e00-\u9fa5]{2,20}(?:公司|大学|集团|机构))/g, "ORG"],
    [/([\u4e00-\u9fa5]{2,4})(?:担任|是)/g, "PERSON"],
    [/([\u4e00-\u9fa5]{2,20}(?:公司|大学|集团|机构))(?:总部位于|位于|的\s*CEO)/g, "ORG"],
    [/(?:总部位于|位于)([\u4e00-\u9fa5]{2,8})/g, "LOC"],
  ];

  for (const [regex, type] of chineseRules) {
    addRegexEntities(text, entities, regex, type);
  }

  return dedupeAndSelectLongest(entities);
}

function isChineseChar(char) {
  return /[\u4e00-\u9fff]/.test(char);
}

function hasEntityAt(entities, start) {
  return entities.some((entity) => entity.start === start);
}

function tokenizeWithOffsets(text, entities) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const entity = entities.find((item) => item.start === index);
    if (entity) {
      const entityText = entity.text;
      if (/[A-Za-z]/.test(entityText)) {
        const pattern = /[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g;
        for (const part of entityText.matchAll(pattern)) {
          tokens.push({
            token: part[0],
            start: entity.start + part.index,
            end: entity.start + part.index + part[0].length,
          });
        }
      } else {
        for (let position = entity.start; position < entity.end; position += 1) {
          tokens.push({ token: text[position], start: position, end: position + 1 });
        }
      }
      index = entity.end;
      continue;
    }

    const word = text.slice(index).match(/^[A-Za-z]+(?:'[A-Za-z]+)?/);
    if (word) {
      tokens.push({ token: word[0], start: index, end: index + word[0].length });
      index += word[0].length;
      continue;
    }

    const number = text.slice(index).match(/^[0-9]+/);
    if (number) {
      tokens.push({ token: number[0], start: index, end: index + number[0].length });
      index += number[0].length;
      continue;
    }

    if (isChineseChar(char)) {
      let end = index + 1;
      while (end < text.length && isChineseChar(text[end]) && !hasEntityAt(entities, end)) {
        end += 1;
      }
      tokens.push({ token: text.slice(index, end), start: index, end });
      index = end;
      continue;
    }

    tokens.push({ token: char, start: index, end: index + 1 });
    index += 1;
  }

  return tokens;
}

function generateBioTags(text, entities) {
  return tokenizeWithOffsets(text, entities).map((token) => {
    const matched = entities.find(
      (entity) => token.start >= entity.start && token.end <= entity.end,
    );
    if (!matched) return { token: token.token, label: "O" };

    return {
      token: token.token,
      label: `${token.start === matched.start ? "B" : "I"}-${matched.type}`,
    };
  });
}

function addRelation(relations, source, target, relation) {
  if (source.text === target.text) return;
  const candidate = { source: source.text, relation, target: target.text };
  const exists = relations.some(
    (item) =>
      item.source === candidate.source &&
      item.relation === candidate.relation &&
      item.target === candidate.target,
  );
  if (!exists) relations.push(candidate);
}

function normalizedTrigger(value) {
  return value.replace(/[，,。.;；:：]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractRelations(text, entities) {
  const relations = [];
  const ordered = [...entities].sort((a, b) => a.start - b.start || a.end - b.end);

  for (const source of ordered) {
    for (const target of ordered) {
      if (source === target || source.end > target.start) continue;

      const trigger = normalizedTrigger(text.slice(source.end, target.start));
      const afterTarget = text.slice(target.end, target.end + 16).replace(/\s+/g, "").toLowerCase();

      if (
        source.type === "PERSON" &&
        target.type === "ORG" &&
        /^(founded|created|创立了?|创建了?|创办了?)$/.test(trigger)
      ) {
        addRelation(relations, source, target, "FOUNDER_OF");
      }

      if (source.type === "PERSON" && target.type === "ORG") {
        const isEnglishCeo = trigger === "is the ceo of";
        const isChineseCeo =
          (trigger === "担任" && afterTarget.startsWith("ceo")) ||
          (trigger === "是" && afterTarget.startsWith("的ceo"));
        if (isEnglishCeo || isChineseCeo) {
          addRelation(relations, source, target, "CEO_OF");
        }
      }

      if (
        source.type === "ORG" &&
        target.type === "LOC" &&
        ["is headquartered in", "which is headquartered in", "总部位于", "该公司总部位于"].includes(trigger)
      ) {
        addRelation(relations, source, target, "HEADQUARTERED_IN");
      }

      if (source.type === "ORG" && target.type === "LOC" && ["is located in", "位于"].includes(trigger)) {
        addRelation(relations, source, target, "LOCATED_IN");
      }

      if (source.type === "ORG" && target.type === "ORG" && /^(acquired|收购了?)$/.test(trigger)) {
        addRelation(relations, source, target, "ACQUIRED");
      }
    }
  }

  return relations;
}

function buildKnowledgeGraph(entities, relations) {
  const nodesById = new Map();

  for (const entity of entities) {
    const id = normalizeMention(entity.text);
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: entity.text, type: entity.type });
    }
  }

  const edges = [];
  const seenEdges = new Set();
  for (const relation of relations) {
    const source = normalizeMention(relation.source);
    const target = normalizeMention(relation.target);
    if (!nodesById.has(source)) nodesById.set(source, { id: source, label: relation.source, type: "UNKNOWN" });
    if (!nodesById.has(target)) nodesById.set(target, { id: target, label: relation.target, type: "UNKNOWN" });

    const key = `${source}:${relation.relation}:${target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source, target, label: relation.relation });
  }

  return { nodes: [...nodesById.values()], edges };
}

function extractInformation(text) {
  const entities = extractEntities(text);
  const bio = generateBioTags(text, entities);
  const relations = extractRelations(text, entities);
  const graph = buildKnowledgeGraph(entities, relations);
  return { entities, bio, relations, graph };
}

function renderEntities(text, result) {
  const output = document.querySelector("#entityOutput");
  const showBio = document.querySelector("#bioToggle").checked;

  if (!text.trim()) {
    output.innerHTML = '<span class="empty">No input yet.</span>';
    return;
  }

  if (showBio) {
    output.innerHTML = `<pre>${escapeHtml(
      result.bio.map((item) => `${item.token}\t${item.label}`).join("\n"),
    )}</pre>`;
    return;
  }

  let cursor = 0;
  let html = "";
  for (const entity of result.entities) {
    html += escapeHtml(text.slice(cursor, entity.start));
    html += `<mark class="${entity.type.toLowerCase()}">${escapeHtml(entity.text)} <span>${typeLabels[entity.type]}</span></mark>`;
    cursor = entity.end;
  }
  html += escapeHtml(text.slice(cursor));
  output.innerHTML = html || '<span class="empty">No entities detected.</span>';
}

function renderRelations(relations) {
  const rows = document.querySelector("#relationRows");
  if (!relations.length) {
    rows.innerHTML = '<tr><td colspan="3" class="empty-cell">No relations detected.</td></tr>';
    return;
  }

  rows.innerHTML = relations
    .map(
      (relation) => `
        <tr>
          <td>${escapeHtml(relation.source)}</td>
          <td><code>${escapeHtml(relation.relation)}</code></td>
          <td>${escapeHtml(relation.target)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderGraph(graph) {
  const container = document.querySelector("#graph");
  const nodes = new vis.DataSet(
    graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      shape: "dot",
      size: node.type === "ORG" ? 26 : 23,
      color: graphColors[node.type] || graphColors.UNKNOWN,
      borderWidth: 2,
      font: { color: "#111827", size: 14, face: "Inter, Arial" },
    })),
  );

  const edges = new vis.DataSet(
    graph.edges.map((edge, index) => ({
      id: index,
      from: edge.source,
      to: edge.target,
      arrows: "to",
      label: edge.label,
      color: { color: "#64748b", highlight: "#1f2937" },
      font: { size: 11, align: "middle", strokeWidth: 4, strokeColor: "#ffffff" },
      smooth: { type: "continuous" },
    })),
  );

  network = new vis.Network(container, { nodes, edges }, {
    physics: {
      stabilization: true,
      barnesHut: { springLength: 130, avoidOverlap: 0.45 },
    },
    interaction: { hover: true, tooltipDelay: 100, navigationButtons: true },
    nodes: { shadow: { enabled: true, size: 8, x: 0, y: 3 } },
  });
}

function runExtraction() {
  const text = document.querySelector("#sourceText").value;
  currentResult = extractInformation(text);
  renderEntities(text, currentResult);
  renderRelations(currentResult.relations);
  renderGraph(currentResult.graph);
}

function setupEvents() {
  document.querySelector("#sourceText").value = defaultText;
  document.querySelector("#extractButton").addEventListener("click", runExtraction);
  document.querySelector("#clearButton").addEventListener("click", () => {
    document.querySelector("#sourceText").value = "";
    runExtraction();
  });
  document.querySelector("#bioToggle").addEventListener("change", runExtraction);
  document.querySelector("#fitGraphButton").addEventListener("click", () => network?.fit({ animation: true }));

  for (const button of document.querySelectorAll("[data-sample]")) {
    button.addEventListener("click", () => {
      const textarea = document.querySelector("#sourceText");
      const sample = samples[Number(button.dataset.sample)];
      textarea.value = textarea.value.trim() ? `${textarea.value.trim()} ${sample}` : sample;
      runExtraction();
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  const waitForVis = window.setInterval(() => {
    if (window.vis) {
      window.clearInterval(waitForVis);
      runExtraction();
    }
  }, 50);
});
