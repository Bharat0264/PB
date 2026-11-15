FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PRINTBEE_DATA_DIR=/var/lib/printbee
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --user-group --no-create-home printbee \
    && install -d -o printbee -g printbee /var/lib/printbee

COPY *.py *.html *.js *.css *.webmanifest *.woff2 *.webp *.png ./

USER printbee
VOLUME ["/var/lib/printbee"]
EXPOSE 4188
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "4188"]
