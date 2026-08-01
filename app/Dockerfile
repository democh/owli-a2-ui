FROM node:20-alpine

WORKDIR /app

# 安装依赖(含构建所需的 devDependencies)
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并构建(前端 dist + 后端 dist/boot.js)
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# 启动前同步数据库表结构,然后启动生产服务
CMD ["sh", "-c", "npm run db:push && npm start"]
