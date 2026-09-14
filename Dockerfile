FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY research/execution/data_acquisition/recorder/requirements.txt /app/requirements.txt
# Two-step install: requirements.txt pins websocket-client==1.8.0 while
# iqoptionapi@master requires websocket-client==0.56, so a single
# `pip install -r requirements.txt` fails with ResolutionImpossible.
# Install iqoptionapi without deps first, then the repo pins + pylint
# (pylint is declared by iqoptionapi itself). requirements.txt untouched.
RUN pip install --no-cache-dir --no-deps "git+https://github.com/Lu-Yi-Hsun/iqoptionapi.git" \
 && pip install --no-cache-dir "websocket-client==1.8.0" "requests==2.32.3" pylint

COPY research/execution/data_acquisition/recorder /app/research/execution/data_acquisition/recorder

RUN mkdir -p /data

ENV PORT=8080
ENV RAW_DIR=/data
ENV IQO_ASSET=XAU/XAG
ENV IQO_INTERVAL=60

EXPOSE 8080

CMD ["python", "research/execution/data_acquisition/recorder/cloud_entrypoint.py"]
