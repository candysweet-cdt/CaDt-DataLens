# 一个简单的 Dockerfile 示例
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/datalens .

FROM alpine:3.19
COPY --from=build /out/datalens /usr/local/bin/datalens
ENTRYPOINT ["datalens"]
