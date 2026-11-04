---
name: pdf-form-filler
description: Fill in fillable PDF forms (AcroForm fields such as text boxes, checkboxes and dropdowns) from user-provided values and save a flattened copy. Use when the user asks to fill out, complete or populate a PDF form, tax form or application PDF.
license: MIT
metadata:
  author: acus9345
  version: "1.0"
---

# PDF form filler

1. List the form fields: `python3 scripts/fill_form.py --list form.pdf`
2. Map the user's values to field names. Field types are described in
   [the field type reference](references/field-types.md#checkboxes-and-radio-buttons).
3. Fill and flatten: `python3 scripts/fill_form.py form.pdf values.json out.pdf`

Never guess values for fields the user did not provide; leave them empty and say so.
