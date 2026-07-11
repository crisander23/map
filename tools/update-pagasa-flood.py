import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

IFRAME_URL = "https://panahon.gov.ph/?trg=iframe&req=public-alerts.gfa"
API_URL = "https://panahon.gov.ph/api/v1/cap-alerts?token={}"
OUT = Path("data/weather-signals.json")


def get_text(url):
    request = Request(url, headers={"User-Agent": "NEA-DDCC-Map/1.0"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def normalize_province(value):
    value = str(value or "").strip().lower()
    value = re.sub(r"province of\s+", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def severity(text):
    text = str(text or "").lower()
    if "extreme" in text:
        return 3
    if "severe" in text:
        return 2
    return 1


def main():
    iframe = get_text(IFRAME_URL)
    token_match = re.search(r'<meta name="csrf-token" content="([^"]+)"', iframe)
    if not token_match:
        raise RuntimeError("PAGASA PANaHON CSRF token was not found")

    payload = json.loads(get_text(API_URL.format(token_match.group(1))))
    alerts = payload.get("data", {}).get("alert_data", [])
    flood_alerts = [
        alert for alert in alerts
        if str(alert.get("event", "")).upper() == "FLOOD"
        and "General Flood Advisory" in str(alert.get("subtype", ""))
    ]

    flood = {}
    normalized_alerts = []
    for alert in flood_alerts:
        level = severity(alert.get("subtype"))
        areas = []
        for area in alert.get("provinces") or []:
            province = area.get("province") or area.get("areaDesc")
            if not province:
                continue
            key = normalize_province(province)
            flood[key] = max(flood.get(key, 0), level)
            areas.append(province)

        normalized_alerts.append({
            "severity": level,
            "subtype": alert.get("subtype", ""),
            "issuedAt": alert.get("issued_date", ""),
            "validUntil": alert.get("valid_date", ""),
            "areas": areas,
        })

    current = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    current["source"] = "PAGASA PANaHON CAP General Flood Advisory"
    current["floodIssuedAt"] = datetime.now(timezone.utc).isoformat()
    current["flood"] = flood
    current["floodAlerts"] = normalized_alerts
    OUT.write_text(json.dumps(current, indent=2), encoding="utf-8")
    print(f"updated {OUT} with {len(flood)} affected provinces from {len(normalized_alerts)} GFA alerts")


if __name__ == "__main__":
    main()