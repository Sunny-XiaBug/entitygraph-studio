"""
EntityGraph Studio information extraction core.

This module implements a lightweight and maintainable extraction pipeline
using only the Python standard library:
1. NER：规则 + 词典 + Mock 增强的命名实体识别。
2. BIO：根据实体 offset 生成 BIO 序列标注。
3. RE：根据实体之间的触发词抽取语义关系。
4. KG：将实体和关系转换为知识图谱节点与边。

Design notes:
- The implementation does not require spaCy, transformers, or networkx.
- Rule and dictionary layers are intentionally transparent, making the
  pipeline easy to audit, extend, and embed in demos or lightweight services.
- 对重叠实体采用“最长实体优先”，例如优先保留
  University of California, Los Angeles，而不是内部的 California。
"""

from __future__ import annotations

import json
import re


ENTITY_DICTIONARY = [
    {"text": "University of California, Los Angeles", "type": "ORG"},
    {"text": "未来科技公司", "type": "ORG"},
    {"text": "Steve Jobs", "type": "PERSON"},
    {"text": "Elon Musk", "type": "PERSON"},
    {"text": "Los Angeles", "type": "LOC"},
    {"text": "California", "type": "LOC"},
    {"text": "Microsoft", "type": "ORG"},
    {"text": "LinkedIn", "type": "ORG"},
    {"text": "Apple", "type": "ORG"},
    {"text": "Tesla", "type": "ORG"},
    {"text": "Austin", "type": "LOC"},
    {"text": "张三", "type": "PERSON"},
    {"text": "北京", "type": "LOC"},
]

PRONOUNS = {"he", "she", "it", "they", "which", "who", "that"}


def clean_mention(text: str) -> str:
    """清理实体或触发词两侧的空白和常见中英文标点。"""
    return re.sub(r"\s+", " ", text.strip(" \t\r\n,，。.;；:：")).strip()


def normalize_mention(text: str) -> str:
    """生成用于去重和匹配的规范化文本。"""
    return clean_mention(text).lower()


def is_chinese_char(char: str) -> bool:
    return "\u4e00" <= char <= "\u9fff"


def dedupe_and_select_longest(entities: list[dict]) -> list[dict]:
    """去重并解决重叠实体：同一重叠区域只保留最长实体。"""
    unique = {}
    for entity in entities:
        key = (entity["start"], entity["end"], entity["type"])
        unique[key] = entity

    selected = []
    sorted_entities = sorted(
        unique.values(),
        key=lambda item: (-(item["end"] - item["start"]), item["start"]),
    )

    for entity in sorted_entities:
        overlaps = any(
            entity["start"] < chosen["end"] and entity["end"] > chosen["start"]
            for chosen in selected
        )
        if not overlaps:
            selected.append(entity)

    return sorted(selected, key=lambda item: (item["start"], item["end"]))


def add_regex_entities(
    text: str,
    entities: list[dict],
    pattern: str,
    entity_type: str,
    group: int = 1,
    flags: int = 0,
) -> None:
    """根据正则规则追加实体，并保留原文中的字符 offset。"""
    for match in re.finditer(pattern, text, flags):
        value = match.group(group)
        if normalize_mention(value) in PRONOUNS:
            continue
        start = match.start(group)
        entities.append(
            {
                "text": text[start : start + len(value)],
                "type": entity_type,
                "start": start,
                "end": start + len(value),
            }
        )


def extract_entities(text: str) -> list[dict]:
    """抽取 PERSON、ORG、LOC 三类实体。"""
    if not text.strip():
        return []

    entities: list[dict] = []

    # 词典匹配覆盖课程要求中的固定样例；英文使用 IGNORECASE 提升健壮性。
    for item in ENTITY_DICTIONARY:
        flags = 0 if re.search(r"[\u4e00-\u9fff]", item["text"]) else re.IGNORECASE
        for match in re.finditer(re.escape(item["text"]), text, flags):
            entities.append(
                {
                    "text": text[match.start() : match.end()],
                    "type": item["type"],
                    "start": match.start(),
                    "end": match.end(),
                }
            )

    # 英文规则增强：用触发词附近的大写短语补充实体。
    english_rules = [
        (
            r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:founded|created)\b",
            "PERSON",
        ),
        (
            r"\b(?:founded|created|acquired)\s+([A-Z][A-Za-z]*(?:\s+(?!in\b|which\b|is\b|the\b|of\b)[A-Z][A-Za-z]*)*)\b",
            "ORG",
        ),
        (
            r"\b(?:in|located\s+in|headquartered\s+in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b",
            "LOC",
        ),
        (
            r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+is\s+the\s+CEO\s+of\b",
            "PERSON",
        ),
        (
            r"\bCEO\s+of\s+([A-Z][A-Za-z]*(?:\s+(?!which\b|is\b|the\b|of\b)[A-Z][A-Za-z]*)*)\b",
            "ORG",
        ),
        (
            r"\b([A-Z][A-Za-z]*(?:\s+(?!is\b)[A-Z][A-Za-z]*)*)\s+is\s+headquartered\s+in\b",
            "ORG",
        ),
        (
            r"\b((?:University|College|Institute)\s+of\s+[A-Z][A-Za-z]+(?:,\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)*)\s+is\s+located\b",
            "ORG",
        ),
    ]

    for pattern, entity_type in english_rules:
        add_regex_entities(text, entities, pattern, entity_type, flags=re.IGNORECASE)

    # 中文规则增强：覆盖“创立/创建/总部位于/CEO”等课程句式。
    chinese_rules = [
        (r"([\u4e00-\u9fa5]{2,4})(?:创立|创建|创办)", "PERSON"),
        (
            r"(?:创立了?|创建了?|创办了?|收购了?)([\u4e00-\u9fa5]{2,20}(?:公司|大学|集团|机构))",
            "ORG",
        ),
        (r"([\u4e00-\u9fa5]{2,4})(?:担任|是)", "PERSON"),
        (
            r"([\u4e00-\u9fa5]{2,20}(?:公司|大学|集团|机构))(?:总部位于|位于|的\s*CEO)",
            "ORG",
        ),
        (r"(?:总部位于|位于)([\u4e00-\u9fa5]{2,8})", "LOC"),
    ]

    for pattern, entity_type in chinese_rules:
        add_regex_entities(text, entities, pattern, entity_type)

    return dedupe_and_select_longest(entities)


def has_entity_at(entities: list[dict], start: int) -> bool:
    return any(entity["start"] == start for entity in entities)


def tokenize_with_offsets(text: str) -> list[dict]:
    """按英文单词/标点、中文实体/短词切分，并保留 token offset。"""
    entities = extract_entities(text)
    tokens: list[dict] = []
    index = 0

    while index < len(text):
        char = text[index]

        if char.isspace():
            index += 1
            continue

        entity = next((item for item in entities if item["start"] == index), None)
        if entity:
            entity_text = entity["text"]
            if re.search(r"[A-Za-z]", entity_text):
                for part in re.finditer(r"[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]", entity_text):
                    tokens.append(
                        {
                            "token": part.group(0),
                            "start": entity["start"] + part.start(),
                            "end": entity["start"] + part.end(),
                        }
                    )
            else:
                for pos in range(entity["start"], entity["end"]):
                    tokens.append({"token": text[pos], "start": pos, "end": pos + 1})
            index = entity["end"]
            continue

        if re.match(r"[A-Za-z]", char):
            match = re.match(r"[A-Za-z]+(?:'[A-Za-z]+)?", text[index:])
            assert match is not None
            token = match.group(0)
            tokens.append({"token": token, "start": index, "end": index + len(token)})
            index += len(token)
            continue

        if char.isdigit():
            match = re.match(r"[0-9]+", text[index:])
            assert match is not None
            token = match.group(0)
            tokens.append({"token": token, "start": index, "end": index + len(token)})
            index += len(token)
            continue

        if is_chinese_char(char):
            # 非实体中文片段合并为短词，遇到下一个实体起点时停止。
            end = index + 1
            while end < len(text) and is_chinese_char(text[end]) and not has_entity_at(entities, end):
                end += 1
            tokens.append({"token": text[index:end], "start": index, "end": end})
            index = end
            continue

        tokens.append({"token": char, "start": index, "end": index + 1})
        index += 1

    return tokens


def generate_bio_tags(text: str, entities: list[dict]) -> list[dict]:
    """根据实体 offset 生成 BIO 标签序列。"""
    tokens = tokenize_with_offsets(text)
    bio: list[dict] = []

    for token in tokens:
        matched = next(
            (
                entity
                for entity in entities
                if token["start"] >= entity["start"] and token["end"] <= entity["end"]
            ),
            None,
        )

        if matched is None:
            label = "O"
        else:
            prefix = "B" if token["start"] == matched["start"] else "I"
            label = f"{prefix}-{matched['type']}"

        bio.append({"token": token["token"], "label": label})

    return bio


def add_relation(relations: list[dict], source: dict, target: dict, relation: str) -> None:
    """追加关系并去重。"""
    if source["text"] == target["text"]:
        return

    item = {
        "source": source["text"],
        "relation": relation,
        "target": target["text"],
    }
    if item not in relations:
        relations.append(item)


def normalized_trigger(text: str) -> str:
    """将实体之间的文本规整成便于规则判断的触发词。"""
    trigger = re.sub(r"[，,。.;；:：]", " ", text)
    trigger = re.sub(r"\s+", " ", trigger).strip().lower()
    return trigger


def extract_relations(text: str, entities: list[dict]) -> list[dict]:
    """基于实体对和中间触发词抽取关系。"""
    if not text.strip() or not entities:
        return []

    relations: list[dict] = []
    ordered_entities = sorted(entities, key=lambda item: (item["start"], item["end"]))

    for source in ordered_entities:
        for target in ordered_entities:
            if source is target or source["end"] > target["start"]:
                continue

            between = text[source["end"] : target["start"]]
            trigger = normalized_trigger(between)
            after_target = re.sub(r"\s+", "", text[target["end"] : target["end"] + 16]).lower()

            if (
                source["type"] == "PERSON"
                and target["type"] == "ORG"
                and re.fullmatch(r"founded|created|创立了?|创建了?|创办了?", trigger)
            ):
                add_relation(relations, source, target, "FOUNDER_OF")

            if source["type"] == "PERSON" and target["type"] == "ORG":
                is_english_ceo = trigger == "is the ceo of"
                is_chinese_ceo = (trigger == "担任" and after_target.startswith("ceo")) or (
                    trigger == "是" and after_target.startswith("的ceo")
                )
                if is_english_ceo or is_chinese_ceo:
                    add_relation(relations, source, target, "CEO_OF")

            if (
                source["type"] == "ORG"
                and target["type"] == "LOC"
                and trigger
                in {"is headquartered in", "which is headquartered in", "总部位于", "该公司总部位于"}
            ):
                add_relation(relations, source, target, "HEADQUARTERED_IN")

            if (
                source["type"] == "ORG"
                and target["type"] == "LOC"
                and trigger in {"is located in", "位于"}
            ):
                add_relation(relations, source, target, "LOCATED_IN")

            if (
                source["type"] == "ORG"
                and target["type"] == "ORG"
                and re.fullmatch(r"acquired|收购了?", trigger)
            ):
                add_relation(relations, source, target, "ACQUIRED")

    return relations


def build_knowledge_graph(entities: list[dict], relations: list[dict]) -> dict:
    """将实体和关系转换为前端可视化常用的 nodes / edges 结构。"""
    nodes_by_id = {}

    for entity in entities:
        node_id = normalize_mention(entity["text"])
        nodes_by_id.setdefault(
            node_id,
            {
                "id": node_id,
                "label": entity["text"],
                "type": entity["type"],
            },
        )

    edges = []
    seen_edges = set()
    for relation in relations:
        source_id = normalize_mention(relation["source"])
        target_id = normalize_mention(relation["target"])

        # 如果关系中的端点不在实体表中，也补一个兜底节点，保证图结构完整。
        nodes_by_id.setdefault(
            source_id,
            {"id": source_id, "label": relation["source"], "type": "UNKNOWN"},
        )
        nodes_by_id.setdefault(
            target_id,
            {"id": target_id, "label": relation["target"], "type": "UNKNOWN"},
        )

        edge_key = (source_id, relation["relation"], target_id)
        if edge_key in seen_edges:
            continue
        seen_edges.add(edge_key)
        edges.append(
            {
                "source": source_id,
                "target": target_id,
                "label": relation["relation"],
                "relation": relation["relation"],
            }
        )

    return {"nodes": list(nodes_by_id.values()), "edges": edges}


def extract_information(text: str) -> dict:
    """完整信息抽取入口：实体、BIO、关系、知识图谱。"""
    entities = extract_entities(text)
    bio = generate_bio_tags(text, entities)
    relations = extract_relations(text, entities)
    graph = build_knowledge_graph(entities, relations)

    return {
        "entities": entities,
        "bio": bio,
        "relations": relations,
        "graph": graph,
    }


if __name__ == "__main__":
    test_text = (
        "Steve Jobs founded Apple in California. "
        "Apple is headquartered in California. "
        "Elon Musk is the CEO of Tesla, which is headquartered in Austin. "
        "Microsoft acquired LinkedIn.\n"
        "张三创立了未来科技公司，该公司总部位于北京。\n"
        "University of California, Los Angeles is located in Los Angeles."
    )

    result = extract_information(test_text)

    print("输入文本:")
    print(test_text)
    print("\nentities:")
    print(json.dumps(result["entities"], ensure_ascii=False, indent=2))
    print("\nbio:")
    print(json.dumps(result["bio"], ensure_ascii=False, indent=2))
    print("\nrelations:")
    print(json.dumps(result["relations"], ensure_ascii=False, indent=2))
    print("\ngraph:")
    print(json.dumps(result["graph"], ensure_ascii=False, indent=2))
