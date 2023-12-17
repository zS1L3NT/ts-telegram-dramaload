FROM selenium/standalone-chrome

WORKDIR /app

USER root
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr bash

COPY . .

RUN bun i

ENV NTBA_FIX_350 1

EXPOSE 9844
CMD bun start