#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генерация Obsidian-витамины «Состояние Deep Dish» из репозитория.

Канон — PLAN.md/SPEC.md в репо; этот скрипт собирает человекочитаемую сводку
и кладёт её в LichVault (Г1 ревью: конец ручной синхронизации 8 файлов).
Запуск при каждом релизе:  python tools/sync_docs.py
"""
import io
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBS = os.path.expanduser(r"~/OneDrive/Documents/LichVault/Личное/Deep Dish")
OUT = os.path.join(OBS, "Состояние Deep Dish.md")


def read(name: str) -> str:
    return io.open(os.path.join(REPO, name), encoding="utf-8").read()


def main() -> None:
    plan = read("PLAN.md")
    spec = read("SPEC.md")
    readme = read("README.md")
    version = re.search(r"Статус:\*\* .*?— (v[\d.]+)", readme)
    version = version.group(1) if version else "?"

    # решения: раздел «Решения В.» — заголовки-числа не несут текста, берём историю
    hist = plan[plan.find("## История изменений плана"):]
    hist_lines = [l for l in hist.splitlines() if l.startswith("- v")][:8]

    # чек-листы итераций из SPEC-плана нет — берём «План итераций» из PLAN
    iters = plan[plan.find("## План итераций"):plan.find("## Регламент документирования")] if "## Регламент документирования" in plan else ""

    out = io.StringIO()
    out.write("> Сгенерировано автоматически из репозитория (tools/sync_docs.py) — руками не править.\n")
    out.write(f"> Версия: {version} · обновлено при релизе\n\n")
    out.write("**Состояние** — из README репо; полный канон — PLAN.md и SPEC.md (github.com/lichmanenko/deep-dish).\n\n")
    out.write("## Что сейчас (статус)\n\n")
    st = re.search(r"\*\*Статус:\*\* ([^\n]+)", readme)
    out.write(f"{st.group(1) if st else '?'}\n\n")
    out.write("## План итераций\n\n")
    out.write(iters.strip() + "\n\n")
    out.write("## Последние изменения (история плана)\n\n")
    out.write("\n".join(hist_lines) + "\n")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(out.getvalue())
    print("OK →", OUT)


if __name__ == "__main__":
    sys.exit(main())
