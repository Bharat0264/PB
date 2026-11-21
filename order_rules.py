"""PrintBee's server-side pricing rules. Prices are integer paise."""
from upload_types import check_name
RATES = (175, 300, 850, 1400)
# Bond paper (heavier, whiter sheet for project reports): black & white single/double, colour single/double.
BOND_RATES = (300, 550, 1200, 2000)
BINDING_RATES = {"none": 0, "glossy": 5000, "blue": 4000}
LIMIT = 50 * 1024 * 1024


def quote_items(items, paper_rates=None, binding_rates=None):
    paper_rates = paper_rates or {"A4": RATES, "A4 Bond": BOND_RATES}
    binding_rates = binding_rates or BINDING_RATES
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("Choose between one and 100 files.")
    documents = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid file options.")
        pages, copies, size = (item[key] for key in ("pages", "copies", "size"))
        colour, duplex = item["colour"], item["duplex"]
        if not (type(pages) is type(copies) is type(size) is int and 1 <= pages <= 10000
                and 1 <= copies <= 100 and 1 <= size <= LIMIT and type(colour) is type(duplex) is bool
                and item["orientation"] in ("Portrait", "Landscape")
                and isinstance(item["name"], str) and 1 <= len(item["name"]) <= 255):
            raise ValueError("Invalid file options.")
        check_name(item["name"])          # only PDF, DOCX, JPG and PNG can be ordered
        binding = item.get("binding", "none")
        if not isinstance(binding, str) or binding not in binding_rates:
            raise ValueError("Invalid binding.")
        paper = item.get("paper", "A4")
        if not isinstance(paper, str) or paper not in paper_rates:
            raise ValueError("Invalid paper size.")
        rates = paper_rates[paper]
        selected = item.get("colourPages")
        if selected is not None and (
            colour or not isinstance(selected, list) or not selected or
            any(type(page) is not int or not 1 <= page <= pages for page in selected) or
            len(set(selected)) != len(selected)
        ):
            raise ValueError("Invalid colour page selection.")
        colour_count = len(selected) if selected is not None else pages if colour else 0
        subtotal = copies * ((pages - colour_count) * rates[duplex]
                             + colour_count * rates[2 + duplex] + binding_rates[binding])
        document = {key: item[key] for key in (
            "name", "size", "pages", "copies", "colour", "duplex", "orientation"
        )} | {"subtotal": subtotal, "binding": binding, "colourPages": selected}
        if paper != "A4":
            document["paper"] = paper
        page_range = item.get("pageRange")
        if page_range is not None:
            if (not isinstance(page_range, list) or len(page_range) != pages
                    or any(type(page) is not int or not 1 <= page <= 10000 for page in page_range)
                    or sorted(set(page_range)) != page_range):
                raise ValueError("Invalid print page range.")
            document["pageRange"] = page_range
        documents.append(document)
    return documents, sum(item["subtotal"] for item in documents)


TRANSITIONS = {
    "warehouse": {"paid": "printing", "printing": "packed"},
    "delivery": {"packed": "out_for_delivery", "out_for_delivery": "delivered"},
}


def advance_order(db, order_id, role, expected):
    """Advance only when the role and current persisted status both match."""
    target = TRANSITIONS.get(role, {}).get(expected)
    if target is None:
        return None
    changed = db.execute(
        "UPDATE orders SET status=? WHERE id=? AND status=?", (target, order_id, expected)
    ).rowcount
    return target if changed else None
