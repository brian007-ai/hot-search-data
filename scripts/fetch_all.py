#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
今日热搜榜 - 统一采集脚本 (档位 0+1)

- RSS 官方源 (36kr/juejin/sspai/arxiv/hn)
- JSON API 源 (zhihu/bilibili/weibo/toutiao/tieba)
- HTML 抓取源 (hupu/ithome)

特性:
- 所有源统一归一化结构
- 失败自动降级 (返回空, 不阻断其他源)
- 请求头伪装 + 随机间隔 (礼貌抓取)
- 去重 (同标题保留热度最高的)
- 按热度倒序输出 top 500

输出: data/hot-items.json
"""

import json
import os
import re
import random
import sys
import time
import hashlib
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
import feedparser
from lxml import html as lxml_html

# ============================================================
# 配置
# ============================================================

TIMEZONE_CN = timezone(timedelta(hours=8))
OUTPUT_FILE = Path("data/hot-items.json")
MAX_ITEMS_PER_SOURCE = 30
MAX_TOTAL_ITEMS = 500

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/html, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

STOPWORDS = set(
    "的 了 是 在 我 有 和 就 不 人 这 为 之 与 等 着 到 也 一个 我们 你们 他们 "
    "什么 怎么 为什么 可以 已经 但是 而且 如果 因为 所以 虽然 不过 还是 或者 "
    "现在 已经 之后 之前 之后 今天 昨天 明天 今年 去年 明年 这个 那个 一些 那些 "
    "表示 说 称 据 将 会 被 把 从 向 对 让 使 让 将 曾 都 又 再 更 最 最 更 "
    "the a an is are was were be been being of and to in for with as at by".split()
)

# ============================================================
# 归一化
# ============================================================

def norm_item(platform, title, url, heat=0, category="news"):
    if not title or not url:
        return None
    title = re.sub(r"\s+", " ", str(title)).strip()
    if not title:
        return None
    try:
        heat = int(heat) if heat else 0
    except (ValueError, TypeError):
        heat = 0
    return {
        "id": f"{platform}_{hashlib.md5(url.encode('utf-8')).hexdigest()[:12]}",
        "platform": platform,
        "title": title,
        "url": url,
        "heat": heat,
        "category": category,
        "fetched_at": datetime.now(TIMEZONE_CN).isoformat(),
    }


def extract_heat(text):
    """从描述文本中提取热度数字"""
    if not text:
        return 0
    m = re.search(r"(\d[\d,]{3,})", str(text))
    if m:
        return int(m.group(1).replace(",", ""))
    return 0


def hn_heat_from_summary(summary):
    """Hacker News: hnrss summary 里通常只有 comments 链接, 没有 points.
    返回 0 让 HN 不参与热度排序, 但仍作为内容源 (RSS 池).
    """
    return 0


# ============================================================
# 源定义
# ============================================================

# ---- RSS 官方源 (零成本, 无反爬) ----
RSS_SOURCES = [
    ("36kr",     "https://36kr.com/feed",                        "tech"),
    ("juejin",   "https://juejin.cn/rss",                        "tech"),
    ("sspai",    "https://sspai.com/feed",                       "tech"),
    ("arxiv_ai", "http://export.arxiv.org/rss/cs.AI",             "tech"),
    ("arxiv_cl", "http://export.arxiv.org/rss/cs.CL",             "tech"),
    ("arxiv_cv", "http://export.arxiv.org/rss/cs.CV",             "tech"),
    ("hn",       "https://hnrss.org/newest?points=50",            "tech"),
    ("ithome_rss", "https://www.ithome.com/rss/",                 "tech"),
]

# ---- JSON API 源 (直连官方, 加 UA) ----
JSON_SOURCES = [
    # (name, url, parser_fn_name, category, headers_extra)

    ("zhihu",    "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50",
     "zhihu_parser",  "news", {"Referer": "https://www.zhihu.com/"}),

    ("bilibili", "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
     "bilibili_parser", "ent", {"Referer": "https://www.bilibili.com/"}),

    ("weibo",    "https://weibo.com/ajax/side/hotSearch",
     "weibo_parser",  "news", {"Referer": "https://weibo.com/"}),

    ("toutiao",  "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
     "toutiao_parser", "news", {"Referer": "https://www.toutiao.com/"}),

    ("tieba",    "https://tieba.baidu.com/hottopic/browse/topicList",
     "tieba_parser",  "news", {"Referer": "https://tieba.baidu.com/"}),
]

# ---- HTML 抓取源 ----
# 注: 虎扑被阿里云 WAF 拦截 (405), IT之家 HTML 与 RSS 重复, 都不再使用
HTML_SOURCES = []

# ============================================================
# JSON 解析器 (每个平台一个函数, 失败返回空)
# ============================================================

def safe_get(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d:
            d = d[k]
        else:
            return default
    return d



def zhihu_parser(data):
    items = []
    try:
        for x in data.get("data", []):
            target = x.get("target") or {}
            title = target.get("title")
            heat = target.get("heat") or 0
            link = safe_get(target, "link", "url", default="")
            if title and link:
                items.append((title, heat, link))
    except Exception as e:
        print(f"[zhihu] parse error: {e}")
    return items


def bilibili_parser(data):
    items = []
    try:
        for x in data.get("data", {}).get("list", []):
            title = x.get("title")
            view = safe_get(x, "stat", "view", default=0)
            short = x.get("short_link_v2") or x.get("short_link") or ""
            bvid = x.get("bvid", "")
            url = short or f"https://www.bilibili.com/video/{bvid}"
            if title and url:
                items.append((title, view, url))
    except Exception as e:
        print(f"[bilibili] parse error: {e}")
    return items


def weibo_parser(data):
    items = []
    try:
        # 新接口结构: data.realtime / data.data
        realtime = data.get("data", {}).get("realtime") or data.get("data", {}).get("data") or []
        for x in realtime:
            word = x.get("word") or x.get("note")
            num = x.get("num") or x.get("raw_hot") or 0
            if word:
                items.append((word, num, f"https://s.weibo.com/weibo?q={word}"))
    except Exception as e:
        print(f"[weibo] parse error: {e}")
    return items


def toutiao_parser(data):
    items = []
    try:
        for x in data.get("data", []) or data.get("hot_event_data", []):
            title = x.get("Title") or x.get("title")
            heat = x.get("HotValue") or x.get("HotValue") or x.get("hot_value") or 0
            url = x.get("Url") or x.get("url") or ""
            if title and url:
                items.append((title, heat, url))
    except Exception as e:
        print(f"[toutiao] parse error: {e}")
    return items


def tieba_parser(data):
    """贴吧热议 (2026-09 实测结构):
    data.bang_topic.topic_list = [{topic_name, topic_url, discuss_num, topic_id, ...}, ...]
    """
    items = []
    try:
        bang_topic = safe_get(data, "data", "bang_topic", default={}) or {}
        topic_list = bang_topic.get("topic_list") or []
        for x in topic_list:
            title = x.get("topic_name") or ""
            url = x.get("topic_url") or ""
            heat = x.get("discuss_num") or 0
            if title and url:
                # url 里可能被 HTML 转义, 清洗一下
                url = url.replace("&amp;", "&")
                items.append((title, heat, url))
    except Exception as e:
        print(f"[tieba] parse error: {e}")
    return items


PARSERS = {
    "zhihu_parser":    zhihu_parser,
    "bilibili_parser": bilibili_parser,
    "weibo_parser":    weibo_parser,
    "toutiao_parser":  toutiao_parser,
    "tieba_parser":    tieba_parser,
    "hupu_parser":     None,   # HTML 源, 见下
    "ithome_parser":   None,
}

# ============================================================
# HTML 解析器
# ============================================================

def hupu_parser(doc):
    items = []
    try:
        for a in doc.xpath('//div[contains(@class, "list-hd")]//a[@href]'):
            title = (a.text_content() or "").strip()
            href = a.get("href", "")
            if title and href:
                url = href if href.startswith("http") else "https://bbs.hupu.com" + href
                items.append((title, 0, url))
    except Exception as e:
        print(f"[hupu] parse error: {e}")
    return items


def ithome_parser(doc):
    items = []
    try:
        seen = set()
        for a in doc.xpath('//a[contains(@href, ".html")]'):
            title = (a.text_content() or "").strip()
            href = a.get("href", "")
            if len(title) < 6 or title in seen:
                continue
            if href.startswith("/"):
                href = "https://www.ithome.com" + href
            seen.add(title)
            items.append((title, 0, href))
    except Exception as e:
        print(f"[ithome] parse error: {e}")
    return items


HTML_PARSERS = {
    "hupu_parser":   hupu_parser,
    "ithome_parser": ithome_parser,
}

# ============================================================
# 抓取器
# ============================================================

def polite_sleep(base=1.5, jitter=3):
    time.sleep(random.uniform(base, base + jitter))


def fetch_rss():
    """RSS 官方源 - 零反爬"""
    items = []
    for name, url, cat in RSS_SOURCES:
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            feed = feedparser.parse(r.content)
            count = 0
            for entry in feed.entries[:MAX_ITEMS_PER_SOURCE]:
                title = entry.get("title", "")
                link = entry.get("link", "")
                summary = entry.get("summary") or entry.get("description") or ""
                # HN 特殊处理: summary 里有 points, 换算成合理热度
                if name == "hn":
                    heat = hn_heat_from_summary(summary)
                else:
                    heat = extract_heat(summary or title)
                it = norm_item(name, title, link, heat, cat)
                if it:
                    items.append(it)
                    count += 1
            print(f"[RSS] {name}: {count} items")
            polite_sleep(0.5, 1.5)
        except Exception as e:
            print(f"[RSS] {name} FAILED: {e}")
    return items


def fetch_json():
    """JSON API 源 - 加 UA + Referer"""
    items = []
    for name, url, parser_name, cat, extra_h in JSON_SOURCES:
        try:
            h = dict(HEADERS)
            h.update(extra_h)
            r = requests.get(url, headers=h, timeout=15)
            if r.status_code != 200:
                print(f"[JSON] {name} HTTP {r.status_code}")
                polite_sleep(1, 2)
                continue
            r.encoding = r.apparent_encoding or "utf-8"
            data = r.json()
            parser = PARSERS.get(parser_name)
            if not parser:
                print(f"[JSON] {name} no parser")
                continue
            rows = parser(data)
            for title, heat, link in rows[:MAX_ITEMS_PER_SOURCE]:
                it = norm_item(name, title, link, heat, cat)
                if it:
                    items.append(it)
            print(f"[JSON] {name}: {len(rows)} items")
            polite_sleep(1.0, 2.0)
        except Exception as e:
            print(f"[JSON] {name} FAILED: {e}")
            polite_sleep(1, 2)
    return items


def fetch_html():
    """HTML 抓取源"""
    items = []
    for name, url, parser_name, cat in HTML_SOURCES:
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            doc = lxml_html.fromstring(r.text)
            parser = HTML_PARSERS.get(parser_name)
            if not parser:
                print(f"[HTML] {name} no parser")
                continue
            rows = parser(doc)
            for title, heat, link in rows[:MAX_ITEMS_PER_SOURCE]:
                it = norm_item(name, title, link, heat, cat)
                if it:
                    items.append(it)
            print(f"[HTML] {name}: {len(rows)} items")
            polite_sleep(1.0, 2.0)
        except Exception as e:
            print(f"[HTML] {name} FAILED: {e}")
            polite_sleep(1, 2)
    return items


# ============================================================
# 主流程
# ============================================================

def dedupe(items):
    """同标题去重, 保留热度最高的"""
    seen = {}
    for it in items:
        key = it["title"].lower().strip()
        if key not in seen or it["heat"] > seen[key]["heat"]:
            seen[key] = it
    return list(seen.values())


def main():
    print(f"=== Fetch started at {datetime.now(TIMEZONE_CN).isoformat()} ===")

    all_items = []
    all_items.extend(fetch_rss())
    all_items.extend(fetch_json())
    all_items.extend(fetch_html())

    print(f"\nTotal raw items: {len(all_items)}")

    deduped = dedupe(all_items)
    print(f"After dedup: {len(deduped)}")

    # 按热度倒序, 无热度的放最后 (按 fetched_at 倒序)
    final = sorted(
        deduped,
        key=lambda x: (x["heat"] > 0, x["heat"], x["fetched_at"]),
        reverse=True,
    )[:MAX_TOTAL_ITEMS]

    # 统计各平台条数
    platform_stats = {}
    for it in final:
        platform_stats[it["platform"]] = platform_stats.get(it["platform"], 0) + 1
    print("Platform coverage:", platform_stats)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "updated_at": datetime.now(TIMEZONE_CN).isoformat(),
        "total": len(final),
        "platforms": platform_stats,
        "items": final,
    }
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nSaved to {OUTPUT_FILE.resolve()} ({len(final)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
