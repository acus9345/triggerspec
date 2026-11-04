#!/usr/bin/env python3
"""Fill AcroForm fields in a PDF (example script; requires pypdf)."""
import json
import sys


def main(argv):
    if len(argv) == 3 and argv[1] == "--list":
        from pypdf import PdfReader
        for name in (PdfReader(argv[2]).get_fields() or {}):
            print(name)
        return 0
    if len(argv) != 4:
        print("usage: fill_form.py --list FORM | fill_form.py FORM VALUES.json OUT", file=sys.stderr)
        return 2
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter(clone_from=PdfReader(argv[1]))
    with open(argv[2], encoding="utf-8") as fh:
        values = json.load(fh)
    for page in writer.pages:
        writer.update_page_form_field_values(page, values, auto_regenerate=False)
    with open(argv[3], "wb") as out:
        writer.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
