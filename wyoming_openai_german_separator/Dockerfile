FROM ghcr.io/roryeckel/wyoming_openai:latest

COPY wyoming_openai_german_separator/apply_german_separator_patch.py /tmp/apply_german_separator_patch.py
RUN python3 /tmp/apply_german_separator_patch.py \
    && rm /tmp/apply_german_separator_patch.py

# Dieselben deutschen Regeln wie im Sprachdienst.
COPY german_text_rules.py /app/german_text_rules.py
