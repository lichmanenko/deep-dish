#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генерация заметки Obsidian «Состояние Deep Dish» из репозитория.

Канон — PLAN.md/SPEC.md в репо; этот скрипт собирает человекочитаемую сводку
и кладёт её в LichVault (Г1 ревью: конец ручной синхронизации 8 файлов).
Запуск при каждом релизе:  python tools/sync_docs.py
"""
import argparse
import io
import json
import os
from pathlib import Path
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBS = os.path.expanduser(r"~/OneDrive/Documents/LichVault/Личное/Deep Dish")
OUT = os.path.join(OBS, "Состояние Deep Dish.md")


def read(name: str) -> str:
    return io.open(os.path.join(REPO, name), encoding="utf-8").read()


def main() -> None:
    parser = argparse.ArgumentParser(description="Сформировать заметку «Состояние Deep Dish».")
    parser.add_argument("--output", default=OUT, help="Путь к заметке или к локальному файлу для проверки")
    args = parser.parse_args()
    plan = read("PLAN.md")
    readme = read("README.md")
    version = "v" + json.loads(read("package.json"))["version"]

    # решения: раздел «Решения В.» — заголовки-числа не несут текста, берём историю
    _, _, hist = plan.partition("## История изменений плана")
    hist_lines = [l for l in hist.splitlines() if l.startswith("- v")][:8]

    # чек-листы итераций из SPEC-плана нет — берём «План итераций» из PLAN
    _, _, iters = plan.partition("## План итераций")
    iters = iters.partition("## Регламент документирования")[0]
    update = re.search(r"^## (\d{2}\.\d{2}\.\d{4} — аудит и следующий шаг)\n(.*?)(?=\n## |\Z)", plan, re.M | re.S)

    out = io.StringIO()
    out.write("> Сгенерировано автоматически из репозитория (tools/sync_docs.py) — руками не править.\n")
    out.write(f"> Версия клиента в репозитории: {version}\n\n")
    out.write("Архитектура, план и журнал изменений находятся в [репозитории Deep Dish](https://github.com/lichmanenko/deep-dish).\n\n")
    out.write("## Что сейчас (статус)\n\n")
    st = re.search(r"\*\*Статус:\*\* ([^\n]+)", readme)
    out.write(f"{st.group(1).split(' [', 1)[0] if st else '?'}\n\n")
    if update:
        update_body = re.sub(r"\]\((docs/[^)]+)\)", lambda m: f"]({Path(REPO, m[1]).as_uri()})", update.group(2))
        out.write(f"## {update.group(1)}\n\n{update_body.strip()}\n\n")
    out.write("## План итераций\n\n")
    out.write(iters.strip() + "\n\n")
    out.write("## Последние изменения (история плана)\n\n")
    out.write("\n".join(hist_lines) + "\n")
    with io.open(args.output, "w", encoding="utf-8", newline="\n") as destination:
        destination.write(out.getvalue())
    print("OK:", args.output)


if __name__ == "__main__":
    main()
