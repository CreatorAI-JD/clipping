# AutoClipper 3.0 cloud server: API + always-on worker (+ ffmpeg, fonts, face model)
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fontconfig curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# caption fonts (SIL Open Font License) from the Google Fonts repository
RUN mkdir -p /usr/share/fonts/truetype/ac && cd /usr/share/fonts/truetype/ac && \
    for f in ofl/anton/Anton-Regular.ttf "ofl/montserrat/Montserrat[wght].ttf" "ofl/inter/Inter[opsz,wght].ttf" ofl/poppins/Poppins-Bold.ttf ofl/archivoblack/ArchivoBlack-Regular.ttf; do \
      curl -fsSL "https://github.com/google/fonts/raw/main/$f" -o "$(basename "$f")" || true; done && fc-cache -f

# optional better face detector (activated only through the skill registry after it wins the evaluation)
RUN mkdir -p /models && curl -fsSL -o /models/face_detection_yunet_2023mar.onnx \
    https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx || true

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY autoclipper ./autoclipper
COPY tests ./tests
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV AC_DATA_DIR=/data PORT=8080 PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=10s CMD curl -fs http://localhost:8080/api/health || exit 1
CMD ["./entrypoint.sh"]
